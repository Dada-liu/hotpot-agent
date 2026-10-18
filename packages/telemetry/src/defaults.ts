// 默认遥测地址：源码常量为空，表示客户端默认不上报。
// 打包前可由打包者替换该常量，运行时则优先使用用户 settings 或 HOTPOT_TELEMETRY_ENDPOINT。
export const DEFAULT_TELEMETRY_ENDPOINT = "";

// 与 package.json 的 version 保持一致；运行时可通过 createTelemetryClient 的 appVersion 覆盖。
export const APP_VERSION = "0.0.0";
