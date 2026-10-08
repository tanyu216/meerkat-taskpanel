/**
 * The CLI's view of the wire vocabulary.
 *
 * The projection itself lives in `src/shared/wire.mjs` and is *re-exported*
 * here, so the server (which cannot import `src/cli`) and the CLI render from
 * one implementation — a second copy is exactly how `display_name` and
 * `displayName` end up in the same JSON document.
 *
 * It is a facade on purpose: commands import from `../wire.mjs`, so moving the
 * projection (as M2 did, into `shared`) did not touch a single command.
 */

export {
  NO_LOOKUP,
  commentToWire,
  dictionaryEntryToWire,
  projectToWire,
  relationToWire,
  reportToWire,
  sessionToWire,
  taskToWire,
  waiverOf,
  waiversFromActivities,
} from "../shared/wire.mjs";
