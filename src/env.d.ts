/**
 * Vite 在构建时注入的编译期常量。
 *
 * `vite.config.ts` 里用 `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`
 * 把 `package.json` 的版本号替换进产物。声明放在这里，TypeScript 才认识它。
 *
 * ⚠️ 单元测试跑的是源码（Node 类型剥离），**不经过 Vite**，所以这个常量在测试
 * 进程里是不存在的。任何使用处都必须有兜底（见 `src/game/constants.ts` 的
 * `GAME_VERSION`），否则测试一 import 就 `ReferenceError`。
 */
declare const __APP_VERSION__: string;
