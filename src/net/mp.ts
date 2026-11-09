/**
 * Everything multiplayer, behind one dynamic import (#162): the app loads it
 * when someone opens a room (or plays with `?lag=`), so single player
 * downloads none of it.
 */
export { characterChoices, loadCharacter, playerCharacter, saveCharacter } from '../game/character';
export { broadcastTransport } from './broadcast';
export { fetchTurn } from './ice';
export { GuestLobby, HostLobby, matchPeers, parseLobby, rosterChanges } from './lobby';
export { NetMatch } from './match';
export { LOBBY_KINDS, MATCH_KINDS, Router } from './transport';
export { webrtcTransport } from './webrtc';
export { desyncCard, lobbyScreen, messageCard, multiplayerMenu } from '../ui/lobby';
export { buildBundle, nudgeWorld } from './desync';
