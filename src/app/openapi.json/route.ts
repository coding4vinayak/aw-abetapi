// The conventional discovery path. `/api/v1/openapi` is the versioned home of
// the document; this re-exports that exact handler, so the two can never tell
// an integrator (or a crawler) different stories. BlueRails and most API
// tooling probe `/openapi.json` first — a 404 there reads as "no contract"
// even when the versioned path is perfect.
//
// `dynamic` cannot be re-exported (Next parses it statically), so only this
// one-line config is repeated; the spec itself has a single source.
export { GET } from "../api/v1/openapi/route";
export const dynamic = "force-dynamic";
