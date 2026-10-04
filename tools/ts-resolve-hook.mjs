// 让 Node 的内置测试运行器能直接加载 TypeScript 源码：
// 类型剥离由 Node 24 原生支持，这里只补一个"省略扩展名时补 .ts"的解析钩子。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATE_EXTENSIONS = ['.ts', '/index.ts'];

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    for (const ext of CANDIDATE_EXTENSIONS) {
      const candidate = specifier + ext;
      try {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) {
          return await nextResolve(candidate, context);
        }
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  return nextResolve(specifier, context);
}
