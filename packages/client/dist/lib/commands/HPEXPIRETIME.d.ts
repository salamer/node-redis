import { RedisCommandArgument } from '.';
export declare const FIRST_KEY_INDEX = 1;
export declare const IS_READ_ONLY = true;
export declare function transformArguments(key: RedisCommandArgument, fields: RedisCommandArgument | Array<RedisCommandArgument>): import(".").RedisCommandArguments;
export declare function transformReply(): Array<number> | null;
