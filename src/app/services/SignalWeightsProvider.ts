import {
  createDefaultSignalWeights,
  SignalWeightsSchema,
  type SignalWeights,
} from "../../domain/entities/SignalWeights.js";
import { type SignalWeightsStore } from "../../adapters/storage/SignalWeightsStore.js";

export interface SignalWeightsProvider {
  resolveSignalWeights(): Promise<SignalWeights>;
}

export class DefaultSignalWeightsProvider implements SignalWeightsProvider {
  private readonly darwinEnabled: boolean;
  private readonly signalWeightsStore: SignalWeightsStore;

  public constructor(input: {
    darwinEnabled: boolean;
    signalWeightsStore: SignalWeightsStore;
  }) {
    this.darwinEnabled = input.darwinEnabled;
    this.signalWeightsStore = input.signalWeightsStore;
  }

  public async resolveSignalWeights(): Promise<SignalWeights> {
    if (!this.darwinEnabled) {
      return createDefaultSignalWeights();
    }

    return SignalWeightsSchema.parse(await this.signalWeightsStore.load());
  }
}
