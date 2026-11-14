import { describe, expect, it } from 'vitest';
import { encodeMsg } from '../src/net/codec';
import { netLog, netMsg, netNote } from '../src/net/netlog';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { room } from './rig';

describe('the net log (#216)', () => {
  it('logs lobby messages both ways, with what matters in each, and leaves match traffic out', () => {
    const rm = room();
    rm.host();
    rm.guest('A');
    const log = netLog();
    expect(log).toMatch(/> A host names H/);
    expect(log).toMatch(/< A hello token/);
    expect(log).toMatch(/> A lobby phase lobby host H \[H A o o o o\] #[0-9a-f]{6}/);
    netMsg('>', 'B', encodeMsg({ k: 'ping', t: 1 } as never));
    expect(netLog()).not.toMatch(/ ping/);
  });

  it('leaves out the room sent again unchanged, but not a change or a drop', () => {
    const rm = room();
    const h = rm.host();
    rm.guest('B');
    const count = () => netLog().split('\n').filter((l) => /> B lobby/.test(l)).length;
    const n = count();
    rm.clock.now += 3000;
    h.lobby.update();
    expect(count()).toBe(n);
    h.lobby.setTeams(true);
    expect(count()).toBe(n + 1);
  });

  it('says why a send was dropped', () => {
    netMsg('x', 'peerXYZ', encodeMsg({ k: 'hello', proto: PROTOCOL_VERSION, build: 'b', mobile: false, char: 1, token: 't' }), 'link held');
    expect(netLog()).toMatch(/x peerXY hello token {2}\[link held\]/);
  });

  it('keeps only the last thousand lines', () => {
    for (let i = 0; i < 1200; i++) netNote(`line ${i}`);
    const lines = netLog().split('\n');
    expect(lines).toHaveLength(1000);
    expect(lines.at(-1)).toMatch(/line 1199$/);
  });
});
