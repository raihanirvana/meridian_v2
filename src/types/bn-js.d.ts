declare module "bn.js" {
  export default class BN {
    public constructor(value?: string | number | bigint | ArrayLike<number>, base?: number, endian?: string);
    public gt(other: BN): boolean;
  }
}
