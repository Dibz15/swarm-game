// The human proxy moved to src/proxy/proxy.ts (#29, #37), so the campaign sims and tests can use it.
export { Proxy, EXPERT as PROXY, knobsFor, type ProxyKnobs, type ProxyOptions } from '../src/proxy/proxy';
