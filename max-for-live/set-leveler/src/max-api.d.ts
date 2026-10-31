// The part of Node for Max's API this device uses. Max provides the module at runtime.
declare module "max-api" {
  const Max: {
    addHandler(name: string, handler: (...args: never[]) => void): void;
    outlet(...args: unknown[]): Promise<void>;
    post(...args: unknown[]): void;
  };
  export default Max;
}
