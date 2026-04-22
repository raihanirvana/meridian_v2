import {
  ScreeningPolicySchema,
  type ScreeningPolicy,
} from "../../domain/rules/screeningRules.js";
import {
  type PolicyOverrides,
  type RuntimePolicyStore,
} from "../../adapters/config/RuntimePolicyStore.js";

export interface PolicyProvider {
  resolveScreeningPolicy(): Promise<ScreeningPolicy>;
}

function mergeScreeningPolicy(
  basePolicy: ScreeningPolicy,
  overrides: PolicyOverrides,
): ScreeningPolicy {
  return ScreeningPolicySchema.parse({
    ...basePolicy,
    ...overrides,
  });
}

export class DefaultPolicyProvider implements PolicyProvider {
  private readonly basePolicy: ScreeningPolicy;
  private readonly runtimePolicyStore: RuntimePolicyStore;

  public constructor(input: {
    basePolicy: ScreeningPolicy;
    runtimePolicyStore: RuntimePolicyStore;
  }) {
    this.basePolicy = ScreeningPolicySchema.parse(input.basePolicy);
    this.runtimePolicyStore = input.runtimePolicyStore;
  }

  public async resolveScreeningPolicy(): Promise<ScreeningPolicy> {
    const overrides = await this.runtimePolicyStore.loadOverrides();
    return mergeScreeningPolicy(this.basePolicy, overrides);
  }
}
