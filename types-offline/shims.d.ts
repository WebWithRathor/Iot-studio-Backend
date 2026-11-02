/* Loose stand-ins for packages that could not be installed offline. */
declare module 'express' {
  import type { IncomingMessage, ServerResponse, Server } from 'node:http';
  export interface CookieOptions { httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none' | boolean; domain?: string; path?: string; maxAge?: number; expires?: Date }
  export interface Request extends IncomingMessage {
    body: any; query: any; params: any; cookies: any; ip?: string; path: string; baseUrl: string; route?: { path: string }; method: string;
    get(name: string): string | undefined;
    requestId: string; user?: import('../src/types/auth.types').AuthUser; validated: { body?: unknown; params?: unknown; query?: unknown };
  }
  export interface Response extends ServerResponse {
    status(code: number): Response; json(body: unknown): Response; set(h: Record<string, string>): Response; cookie(n: string, v: string, o?: CookieOptions): Response; clearCookie(n: string, o?: CookieOptions): Response;
    getHeader(name: string): any; headersSent: boolean;
  }
  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void;
  export interface Router { use(...a: any[]): Router; get(...a: any[]): Router; post(...a: any[]): Router; put(...a: any[]): Router; patch(...a: any[]): Router; delete(...a: any[]): Router }
  export function Router(opts?: { mergeParams?: boolean }): Router;
  export interface Express extends Router { disable(k: string): void; set(k: string, v: unknown): void; listen(port: number, host: string, cb?: () => void): Server }
  interface ExpressFn { (): Express; json(o?: any): RequestHandler; Router: typeof Router }
  const e: ExpressFn;
  export default e;
}
declare module 'cookie-parser' { const f: () => any; export default f; }
declare module 'cors' { const f: (o: any) => any; export default f; }
declare module 'helmet' { const f: (o: any) => any; export default f; }
declare module 'express-rate-limit' {
  export interface Options { windowMs: number; limit: number; standardHeaders: any; legacyHeaders: boolean; passOnStoreError: boolean; store: any; handler: (req: any, res: any) => void; keyGenerator: (req: any) => string; message: string }
  const rateLimit: (o: Partial<Options>) => import('express').RequestHandler;
  export default rateLimit;
}
declare module 'rate-limit-redis' { export type RedisReply = any; export class RedisStore { constructor(o: { prefix: string; sendCommand: (...a: string[]) => Promise<RedisReply> }) } }
declare module 'jsonwebtoken' {
  export interface JwtPayload { [k: string]: any; exp?: number; sub?: string }
  const jwt: { sign(p: object, s: string, o: any): string; verify(t: string, s: string, o: any): JwtPayload | string };
  export default jwt;
}
declare module 'argon2' {
  export const argon2id: number;
  export function hash(p: string, o?: any): Promise<string>;
  export function verify(h: string, p: string): Promise<boolean>;
  export function needsRehash(h: string, o?: any): boolean;
}
declare module 'ioredis' {
  class Redis {
    constructor(url: string, o?: any);
    on(e: string, cb: (...a: any[]) => void): this; connect(): Promise<void>; quit(): Promise<string>; disconnect(): void; ping(): Promise<string>;
    multi(): any; pipeline(): any; hgetall(k: string): Promise<Record<string, string>>; exists(...k: string[]): Promise<number>; del(...k: string[]): Promise<number>;
    flushdb(): Promise<string>; get(k: string): Promise<string | null>; set(...a: any[]): Promise<any>; eval(...a: any[]): Promise<unknown>; call(...a: any[]): Promise<unknown>;
  }
  export default Redis;
}
declare module 'mqtt' {
  export interface MqttClient {
    connected: boolean; on(e: string, cb: (...a: any[]) => void): this;
    subscribe(t: string | string[], o: any, cb?: (err?: Error | null) => void): void; unsubscribe(t: string, cb?: () => void): void;
    publish(t: string, p: string, o: any, cb?: (err?: Error) => void): void; end(force: boolean, o: object, cb: () => void): void;
  }
  const mqtt: { connect(url: string, o: any): MqttClient };
  export default mqtt;
}
declare module 'winston' {
  namespace winston {
    interface Logger { error(m: string, meta?: object): void; warn(m: string, meta?: object): void; info(m: string, meta?: object): void; http(m: string, meta?: object): void; debug(m: string, meta?: object): void; child(o: object): Logger; on(e: string, cb: () => void): void; end(): void }
    type transport = any;
    const format: any;
    const transports: { Console: new (o: any) => transport };
    function createLogger(o: any): Logger;
  }
  export default winston;
}
declare module 'winston-daily-rotate-file' { const T: new (o: any) => any; export default T; }
declare module 'supertest' { const request: any; export default request; }
declare module 'mongoose' {
  export namespace Types { class ObjectId { constructor(id?: string); toString(): string; equals(o: unknown): boolean } }
  export type ClientSession = { withTransaction(fn: () => Promise<void>): Promise<void>; endSession(): Promise<void> };
  export type FilterQuery<T> = { [k: string]: any };
  export type SortOrder = 1 | -1 | 'asc' | 'desc';
  export interface Query<R = any> {
    lean<L = any>(): Query<L>; exec(): Promise<R>; sort(s: any): Query<R>; skip(n: number): Query<R>; limit(n: number): Query<R>; select(s: any): Query<R>; session(s: any): Query<R>;
  }
  export interface Model<T> {
    modelName: string; collection: { collectionName: string };
    create(docs: any, o?: any): any; insertMany(docs: any, o?: any): Promise<any[]>; find(f?: any): Query; findOne(f: any): Query; findById(id: any): Query;
    findOneAndUpdate(f: any, u: any, o?: any): Query; findByIdAndUpdate(id: any, u: any, o?: any): Query; updateOne(f: any, u: any, o?: any): Query; updateMany(f: any, u: any, o?: any): Query;
    deleteOne(f: any, o?: any): Query; deleteMany(f: any, o?: any): Query; countDocuments(f?: any): Query; estimatedDocumentCount(): Query; exists(f: any): Query; aggregate<R>(p: any[]): { exec(): Promise<R[]> };
    createIndexes(): Promise<void>; __doc?: T;
  }
  export class Schema<T = any> {
    constructor(def: any, o?: any);
    index(f: any, o?: any): void;
    static Types: { ObjectId: any; Mixed: any };
  }
  export function model<T>(name: string, s: Schema<T>): Model<T>;
  const mongoose: {
    set(k: string, v: unknown): void; connect(uri: string, o?: any): Promise<void>; disconnect(): Promise<void>; startSession(): Promise<ClientSession>;
    connection: { readyState: number; host: string; name: string; db?: { admin(): { command(c: object): Promise<any> }; dropDatabase(): Promise<void> }; on(e: string, cb: (...a: any[]) => void): void };
  };
  export default mongoose;
}
