import { pathToFileURL } from "node:url";
const SHIM = pathToFileURL("/tmp/T-20261014-154730-2/http-shim/index.mjs").href;
export async function resolve(specifier, context, next) {
  if (specifier === "node:http" || specifier === "http") return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  return next(url, context);
}
