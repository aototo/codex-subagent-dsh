declare module '@deepseek-ai/cordis' {
  export interface Context {
    connection: {
      rpc: {
        handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>): () => Promise<void>;
      };
      fetch: {
        register(route: {
          path: string;
          methods: readonly string[];
          requestBody: 'buffered' | 'streaming';
          fetch(request: Request): Promise<Response>;
        }): () => Promise<void>;
      };
    };
    sessionController: {
      resolveAgent(sessionId: string): Promise<any>;
      modelCatalog(): Promise<any>;
    };
    agents: { list(): any[] };
    sessions: { flush(session: any): Promise<boolean> };
    inject(dependencies: string[], callback: (ctx: Context) => void): () => void;
    on(name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void;
    effect(callback: () => (() => void | Promise<void>)): () => void;
  }
}

declare module '@deepseek-ai/dsh-api-session-controller' {
  export type SessionController = any;
}
