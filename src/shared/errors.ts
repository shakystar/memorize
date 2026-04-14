export class MemorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemorizeError';
  }
}
