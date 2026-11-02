const PORT = Number(process.env.PORT || 3006);
const ROOM_ID = 'public-home';
const IDLE_TTL_MS = 15000;
const MAX_SOCKETS = 500;
const MAX_ROOMS = 32;
const MAX_ROOM_PARTICIPANTS = 200;
const MAX_MESSAGE_BYTES = 4096;
const KNOWN_ROOM_IDS = new Set(['public-home', 'links-home', 'ngl-home']);
const CLEANUP_INTERVAL_MS = 5000;

const isProduction = process.env.NODE_ENV === 'production';
const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins =
  configuredAllowedOrigins.length > 0
    ? configuredAllowedOrigins
    : isProduction
      ? ['https://naufalrf.net', 'https://links.naufalrf.net', 'https://ngl.naufalrf.net']
      : [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          'http://localhost:3002',
          'http://127.0.0.1:3002',
          'http://localhost:3003',
          'http://127.0.0.1:3003',
        ];

type PresenceParticipant = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  isTouching: boolean;
  pagePath: string;
  pageLabel: string;
  sectionId: string | null;
  sectionLabel: string | null;
  lastSeen: number;
};

type ConnectionData = {
  socketId: string;
  roomId: string | null;
};

type PresenceSocket = {
  data: ConnectionData;
  send(message: string): void;
};

type PresenceUpgradeServer = {
  upgrade(request: Request, options: { data: ConnectionData }): boolean;
};

type JoinPayload = Extract<ClientMessage, { type: 'join' }>['payload'];
type MovePayload = Extract<ClientMessage, { type: 'move' }>['payload'];

type ClientMessage =
  | {
      type: 'join';
      payload: {
        roomId?: string;
        name?: string;
        color?: string;
        x?: number;
        y?: number;
        isTouching?: boolean;
        pagePath?: string;
        pageLabel?: string;
        sectionId?: string | null;
        sectionLabel?: string | null;
      };
    }
  | {
      type: 'move';
      payload: {
        x?: number;
        y?: number;
        isTouching?: boolean;
        sectionId?: string | null;
        sectionLabel?: string | null;
      };
    }
  | { type: 'ping' }
  | { type: 'leave' };

type ServerMessage =
  | {
      type: 'welcome';
      payload: { selfId: string; roomId: string };
    }
  | {
      type: 'state';
      payload: { participants: PresenceParticipant[] };
    }
  | {
      type: 'overview';
      payload: { participants: PresenceParticipant[] };
    };

const roomParticipants = new Map<string, Map<string, PresenceParticipant>>();
const sockets = new Set<PresenceSocket>();

function createCorsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin':
      origin && isAllowedOrigin(origin) ? origin : 'https://naufalrf.net',
    Vary: 'Origin',
  };
}

function clampCoordinate(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

function sanitizeName(value: string | undefined): string {
  const trimmed = (value || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return 'Guest';
  }

  return trimmed.slice(0, 32);
}

function sanitizeColor(value: string | undefined): string {
  const trimmed = (value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : '#3B82F6';
}

function sanitizePath(value: string | undefined): string {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return '/';
  }

  return trimmed.startsWith('/') ? trimmed.slice(0, 80) : `/${trimmed.slice(0, 79)}`;
}

function sanitizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = (value || '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 48) : fallback;
}

function sanitizeSectionId(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed.slice(0, 48) : null;
}

function sanitizeRoomId(value: string | undefined): string {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return ROOM_ID;
  }

  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) {
    return ROOM_ID;
  }
  if (KNOWN_ROOM_IDS.has(safe)) {
    return safe;
  }
  return roomParticipants.size >= MAX_ROOMS ? ROOM_ID : safe;
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) {
    return !isProduction;
  }

  return allowedOrigins.includes(origin);
}

function getRoom(roomId: string): Map<string, PresenceParticipant> {
  let room = roomParticipants.get(roomId);
  if (!room) {
    room = new Map();
    roomParticipants.set(roomId, room);
  }
  return room;
}

function broadcastState(roomId: string): void {
  const room = getRoom(roomId);
  const payload: ServerMessage = {
    type: 'state',
    payload: { participants: Array.from(room.values()) },
  };
  const message = JSON.stringify(payload);

  for (const socket of sockets) {
    if (socket.data.roomId === roomId) {
      try {
        socket.send(message);
      } catch {
      }
    }
  }

  broadcastOverview();
}

function broadcastOverview(): void {
  const participants = Array.from(roomParticipants.values()).flatMap((room) =>
    Array.from(room.values())
  );
  const payload: ServerMessage = {
    type: 'overview',
    payload: { participants },
  };
  const message = JSON.stringify(payload);

  for (const socket of sockets) {
    try {
      socket.send(message);
    } catch {
    }
  }
}

function joinRoom(socket: PresenceSocket, payload: JoinPayload): void {
  const roomId = sanitizeRoomId(payload.roomId);

  if (socket.data.roomId && socket.data.roomId !== roomId) {
    leaveRoom(socket);
  }

  const room = getRoom(roomId);
  if (!room.has(socket.data.socketId) && room.size >= MAX_ROOM_PARTICIPANTS) {
    return;
  }

  const participant: PresenceParticipant = {
    id: socket.data.socketId,
    name: sanitizeName(payload.name),
    color: sanitizeColor(payload.color),
    x: clampCoordinate(payload.x, 0.5),
    y: clampCoordinate(payload.y, 0.5),
    isTouching: Boolean(payload.isTouching),
    pagePath: sanitizePath(payload.pagePath),
    pageLabel: sanitizeLabel(payload.pageLabel, 'Home'),
    sectionId: sanitizeSectionId(payload.sectionId),
    sectionLabel: payload.sectionLabel ? sanitizeLabel(payload.sectionLabel, 'Section') : null,
    lastSeen: Date.now(),
  };

  socket.data.roomId = roomId;
  room.set(socket.data.socketId, participant);
  socket.send(
    JSON.stringify({
      type: 'welcome',
      payload: { selfId: socket.data.socketId, roomId },
    } satisfies ServerMessage)
  );
  broadcastState(roomId);
}

function leaveRoom(socket: PresenceSocket): void {
  const roomId = socket.data.roomId;
  if (!roomId) {
    return;
  }

  const room = getRoom(roomId);
  room.delete(socket.data.socketId);
  socket.data.roomId = null;

  if (room.size === 0) {
    roomParticipants.delete(roomId);
  } else {
    broadcastState(roomId);
  }
}

function updatePresence(socket: PresenceSocket, payload: MovePayload): void {
  const roomId = socket.data.roomId;
  if (!roomId) {
    return;
  }

  const room = getRoom(roomId);
  const participant = room.get(socket.data.socketId);
  if (!participant) {
    return;
  }

  participant.x = clampCoordinate(payload.x, participant.x);
  participant.y = clampCoordinate(payload.y, participant.y);
  participant.isTouching = Boolean(payload.isTouching);
  participant.sectionId = sanitizeSectionId(payload.sectionId);
  participant.sectionLabel = payload.sectionLabel
    ? sanitizeLabel(payload.sectionLabel, 'Section')
    : null;
  participant.lastSeen = Date.now();
  room.set(socket.data.socketId, participant);
  broadcastState(roomId);
}

setInterval(() => {
  const now = Date.now();

  for (const [roomId, room] of roomParticipants.entries()) {
    let changed = false;

    for (const [participantId, participant] of room.entries()) {
      if (now - participant.lastSeen > IDLE_TTL_MS) {
        room.delete(participantId);
        changed = true;
      }
    }

    if (room.size === 0) {
      roomParticipants.delete(roomId);
      continue;
    }

    if (changed) {
      broadcastState(roomId);
    }
  }
}, CLEANUP_INTERVAL_MS);

const server = Bun.serve<ConnectionData>({
  port: PORT,
  idleTimeout: 30,
  fetch(req: Request, server: PresenceUpgradeServer) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');

    if (req.method === 'OPTIONS' && url.pathname === '/health') {
      return new Response(null, {
        status: 204,
        headers: {
          ...createCorsHeaders(origin),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true }, { headers: createCorsHeaders(origin) });
    }

    if (url.pathname === '/ws') {
      if (!isAllowedOrigin(origin)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (sockets.size >= MAX_SOCKETS) {
        return new Response('Too many connections', { status: 503 });
      }

      const upgraded = server.upgrade(req, {
        data: {
          socketId: crypto.randomUUID(),
          roomId: null,
        },
      });

      if (upgraded) {
        return undefined;
      }
    }

    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(socket: PresenceSocket) {
      sockets.add(socket);
    },
    message(socket: PresenceSocket, rawMessage: unknown) {
      let parsed: ClientMessage;

      const raw = String(rawMessage);
      if (raw.length > MAX_MESSAGE_BYTES) {
        return;
      }

      try {
        parsed = JSON.parse(raw) as ClientMessage;
      } catch {
        return;
      }

      if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        return;
      }

      if (parsed.type === 'join') {
        joinRoom(socket, parsed.payload || {});
        return;
      }

      if (parsed.type === 'move') {
        updatePresence(socket, parsed.payload || {});
        return;
      }

      if (parsed.type === 'ping') {
        const roomId = socket.data.roomId;
        if (!roomId) {
          return;
        }
        const room = getRoom(roomId);
        const participant = room.get(socket.data.socketId);
        if (!participant) {
          return;
        }
        participant.lastSeen = Date.now();
        room.set(socket.data.socketId, participant);
        return;
      }

      if (parsed.type === 'leave') {
        leaveRoom(socket);
      }
    },
    close(socket: PresenceSocket) {
      leaveRoom(socket);
      sockets.delete(socket);
    },
  },
});

console.log(`[live-presence] listening on http://localhost:${server.port}`);
