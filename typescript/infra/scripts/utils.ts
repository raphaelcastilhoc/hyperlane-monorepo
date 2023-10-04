import { Keypair } from '@solana/web3.js';
import { Wallet } from 'ethers';
import path from 'path';
import yargs from 'yargs';

import {
  AgentConnectionType,
  AllChains,
  ChainMap,
  ChainMetadata,
  ChainMetadataManager,
  ChainName,
  Chains,
  CoreConfig,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
  ProxiedRouterConfig,
  RouterConfig,
  collectValidators,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objMap,
  promiseObjAll,
  strip0x,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import { environments } from '../config/environments';
import { getCurrentKubernetesContext } from '../src/agents';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import {
  DeployEnvironment,
  EnvironmentConfig,
  RootAgentConfig,
} from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { EnvironmentNames, deployEnvToSdkEnv } from '../src/config/environment';
import { Role } from '../src/roles';
import { assertContext, assertRole, readJSON } from '../src/utils/utils';

export enum Modules {
  ISM_FACTORY = 'ism',
  CORE = 'core',
  HOOK = 'hook',
  HOOK_FACTORY = 'hookfactory',
  INTERCHAIN_GAS_PAYMASTER = 'igp',
  INTERCHAIN_ACCOUNTS = 'ica',
  INTERCHAIN_QUERY_SYSTEM = 'iqs',
  LIQUIDITY_LAYER = 'll',
  TEST_QUERY_SENDER = 'testquerysender',
  TEST_RECIPIENT = 'testrecipient',
  HELLO_WORLD = 'helloworld',
}

export const SDK_MODULES = [
  Modules.ISM_FACTORY,
  Modules.CORE,
  Modules.INTERCHAIN_GAS_PAYMASTER,
  Modules.INTERCHAIN_ACCOUNTS,
  Modules.INTERCHAIN_QUERY_SYSTEM,
];

export function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .demandOption('environment')
    .alias('e', 'environment');
}

export function withModuleAndFork<T>(args: yargs.Argv<T>) {
  return args
    .choices('module', Object.values(Modules))
    .demandOption('module')
    .alias('m', 'module')
    .describe('fork', 'network to fork')
    .choices('fork', Object.values(Chains))
    .alias('f', 'fork');
}

export function withContext<T>(args: yargs.Argv<T>) {
  return args
    .describe('context', 'deploy context')
    .default('context', Contexts.Hyperlane)
    .coerce('context', assertContext)
    .demandOption('context');
}

export function withProtocol<T>(args: yargs.Argv<T>) {
  return args
    .describe('protocol', 'protocol type')
    .default('protocol', ProtocolType.Ethereum)
    .choices('protocol', Object.values(ProtocolType))
    .demandOption('protocol');
}

export function withAgentRole<T>(args: yargs.Argv<T>) {
  return args
    .describe('role', 'agent roles')
    .array('role')
    .coerce('role', (role: string[]): Role[] => role.map(assertRole))
    .demandOption('role')
    .alias('r', 'role');
}

export function withKeyRoleAndChain<T>(args: yargs.Argv<T>) {
  return args
    .describe('role', 'key role')
    .choices('role', Object.values(Role))
    .demandOption('role')
    .alias('r', 'role')

    .describe('chain', 'chain name')
    .choices('chain', AllChains)
    .demandOption('chain')
    .alias('c', 'chain')

    .describe('index', 'index of role')
    .number('index')
    .alias('i', 'index');
}

export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${EnvironmentNames}`,
  );
}

export function getEnvironmentConfig(environment: DeployEnvironment) {
  return environments[environment];
}

export async function getConfigsBasedOnArgs(argv?: {
  environment: DeployEnvironment;
  context: Contexts;
}) {
  const { environment, context = Contexts.Hyperlane } = argv
    ? argv
    : await withContext(getArgs()).argv;
  const envConfig = getEnvironmentConfig(environment);
  const agentConfig = getAgentConfig(context, envConfig);
  return { envConfig, agentConfig, context, environment };
}

// Gets the agent config of a specific context.
export function getAgentConfig(
  context: Contexts,
  environment: EnvironmentConfig | DeployEnvironment,
): RootAgentConfig {
  const coreConfig =
    typeof environment == 'string'
      ? getEnvironmentConfig(environment)
      : environment;
  const agentConfig = coreConfig.agents[context];
  if (!agentConfig)
    throw Error(
      `Invalid context ${context} for environment, must be one of ${Object.keys(
        coreConfig.agents,
      )}.`,
    );
  return agentConfig;
}

function getKeyForRole(
  environment: DeployEnvironment,
  context: Contexts,
  chain: ChainName,
  role: Role,
  index?: number,
): CloudAgentKey {
  const environmentConfig = environments[environment];
  const agentConfig = getAgentConfig(context, environmentConfig);
  return getCloudAgentKey(agentConfig, role, chain, index);
}

export async function getMultiProviderForRole(
  txConfigs: ChainMap<ChainMetadata>,
  environment: DeployEnvironment,
  context: Contexts,
  role: Role,
  index?: number,
  connectionType?: AgentConnectionType,
): Promise<MultiProvider> {
  if (process.env.CI === 'true') {
    return new MultiProvider(); // use default RPCs
  }

  const multiProvider = new MultiProvider(txConfigs);
  await promiseObjAll(
    objMap(txConfigs, async (chain, _) => {
      const provider = await fetchProvider(environment, chain, connectionType);
      const key = getKeyForRole(environment, context, chain, role, index);
      const signer = await key.getSigner(provider);
      multiProvider.setProvider(chain, provider);
      multiProvider.setSigner(chain, signer);
    }),
  );
  return multiProvider;
}

// Note: this will only work for keystores that allow key's to be extracted.
// I.e. GCP will work but AWS HSMs will not.
export async function getKeysForRole(
  txConfigs: ChainMap<ChainMetadata>,
  environment: DeployEnvironment,
  context: Contexts,
  role: Role,
  index?: number,
): Promise<ChainMap<CloudAgentKey>> {
  if (process.env.CI === 'true') {
    return {};
  }

  const keys = await promiseObjAll(
    objMap(txConfigs, async (chain, _) => {
      const key = getKeyForRole(environment, context, chain, role, index);
      if (!key.privateKey)
        throw new Error(`Key for ${chain} does not have private key`);
      return key;
    }),
  );
  return keys;
}

// Note: this will only work for keystores that allow key's to be extracted.
export function getAddressesForKey(
  keys: ChainMap<CloudAgentKey>,
  chain: ChainName,
  manager: ChainMetadataManager<any>,
) {
  const protocol = manager.getChainMetadata(chain).protocol;
  if (protocol === ProtocolType.Ethereum) {
    return new Wallet(keys[chain]).address;
  } else if (protocol === ProtocolType.Sealevel) {
    return Keypair.fromSeed(
      Buffer.from(strip0x(keys[chain].privateKey), 'hex'),
    ).publicKey.toBase58();
  } else {
    throw Error(`Protocol ${protocol} not supported`);
  }
}

export function getContractAddressesSdkFilepath() {
  return path.join('../sdk/src/consts/environments');
}

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments/', environment);
}

export function getModuleDirectory(
  environment: DeployEnvironment,
  module: Modules,
  context?: Contexts,
) {
  // for backwards compatibility with existing paths
  const suffixFn = () => {
    switch (module) {
      case Modules.INTERCHAIN_ACCOUNTS:
        return 'middleware/accounts';
      case Modules.INTERCHAIN_QUERY_SYSTEM:
        return 'middleware/queries';
      case Modules.LIQUIDITY_LAYER:
        return 'middleware/liquidity-layer';
      case Modules.HELLO_WORLD:
        return `helloworld/${context}`;
      default:
        return module;
    }
  };
  return path.join(getEnvironmentDirectory(environment), suffixFn());
}

export function getInfraAddresses(
  environment: DeployEnvironment,
  module: Modules,
) {
  return readJSON(getModuleDirectory(environment, module), 'addresses.json');
}

export function getAddresses(environment: DeployEnvironment, module: Modules) {
  if (SDK_MODULES.includes(module) && environment !== 'test') {
    return readJSON(
      getContractAddressesSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
  } else {
    return getInfraAddresses(environment, module);
  }
}

export function getMailboxAddresses(environment: DeployEnvironment) {
  const mailboxes: ChainMap<Address> = {};
  for (const chain in getAddresses(environment, Modules.CORE)) {
    mailboxes[chain] = getAddresses(environment, Modules.CORE)[chain].mailbox;
  }
  return mailboxes;
}

export function getAggregationHookFactoryAddresses(
  environment: DeployEnvironment,
) {
  const aggregationFactories: ChainMap<Address> = {};
  for (const chain in getAddresses(environment, Modules.HOOK_FACTORY)) {
    aggregationFactories[chain] = getAddresses(
      environment,
      Modules.HOOK_FACTORY,
    )[chain].aggregationHookFactory;
  }
  return aggregationFactories;
}

export function getAgentConfigDirectory() {
  return path.join('../../', 'rust', 'config');
}

export async function assertCorrectKubeContext(coreConfig: EnvironmentConfig) {
  const currentKubeContext = await getCurrentKubernetesContext();
  if (
    !currentKubeContext.endsWith(`${coreConfig.infra.kubernetes.clusterName}`)
  ) {
    const cluster = coreConfig.infra.kubernetes.clusterName;
    console.error(
      `Cowardly refusing to deploy using current k8s context ${currentKubeContext}; are you sure you have the right k8s context active?`,
      `Want clusterName ${cluster}`,
      `Run gcloud container clusters get-credentials ${cluster} --zone us-east1-c`,
    );
    process.exit(1);
  }
}

export async function getRouterConfig(
  environment: DeployEnvironment,
  multiProvider: MultiProvider,
  useMultiProviderOwners = false,
): Promise<ChainMap<RouterConfig>> {
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const owners = getEnvironmentConfig(environment).owners;
  const config: ChainMap<RouterConfig> = {};
  const knownChains = multiProvider.intersect(
    core.chains().concat(igp.chains()),
  ).intersection;

  for (const chain of knownChains) {
    config[chain] = {
      owner: useMultiProviderOwners
        ? await multiProvider.getSignerAddress(chain)
        : owners[chain],
      mailbox: core.getContracts(chain).mailbox.address,
      hook: igp.getContracts(chain).interchainGasPaymaster.address,
    };
  }
  return config;
}

export async function getProxiedRouterConfig(
  environment: DeployEnvironment,
  multiProvider: MultiProvider,
  useMultiProviderOwners = false,
): Promise<ChainMap<ProxiedRouterConfig>> {
  const config = await getRouterConfig(
    environment,
    multiProvider,
    useMultiProviderOwners,
  );
  return objMap(config, (chain, routerConfig) => ({
    timelock: environments[environment].core[chain].upgrade?.timelock,
    ...routerConfig,
  }));
}

export function getValidatorsByChain(
  config: ChainMap<CoreConfig>,
): ChainMap<Set<string>> {
  const validators: ChainMap<Set<string>> = {};
  for (const chain of Object.keys(config)) {
    // Pulls the validators for each chain from a *single* IsmConfig
    const setsByChain = objMap(config, (local) =>
      collectValidators(local, config[chain].defaultIsm),
    );
    objMap(setsByChain, (chain, set) => {
      if (!validators[chain]) {
        validators[chain] = new Set();
      }
      [...set].map((v) => validators[chain].add(v));
    });
  }
  return validators;
}
