import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL("/tmp/T-20261014-154730-2/http-shim/loader.mjs").href, import.meta.url);
