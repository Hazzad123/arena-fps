// Text chat.
//
// The fiddly part isn't the messages, it's the pointer lock. Typing needs the
// lock released so keystrokes reach the input, but releasing it is also the signal
// this game uses to open the pause menu. So opening chat sets a flag that the lock
// handler checks, and closing chat takes the pointer back.

const MAX_LINES = 7;
const FADE_AFTER_MS = 7000;

export function createChat({ onSend, onOpenChange }) {
  const chat = {
    root: document.getElementById('chat'),
    log: document.getElementById('chat-log'),
    compose: document.getElementById('chat-compose'),
    input: document.getElementById('chat-input'),
    scopeLabel: document.getElementById('chat-scope'),
    open: false,
    teamMode: false, // whether team chat is available at all
    team: false, // whether this message is team-only
    recentTimer: null,
    onSend,
    onOpenChange,
  };

  // Keys are handled here, on the input itself, so they can't leak into the game
  // while it has focus.
  chat.input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      const text = chat.input.value.trim();
      chat.input.value = '';
      if (text) chat.onSend(text, chat.team);
      close(chat);
    } else if (e.code === 'Escape') {
      e.preventDefault();
      chat.input.value = '';
      close(chat);
    } else if (e.code === 'Tab') {
      // Toggle between all and team without closing.
      e.preventDefault();
      if (chat.teamMode) setScope(chat, !chat.team);
    }
  });

  return chat;
}

function setScope(chat, team) {
  chat.team = team && chat.teamMode;
  chat.scopeLabel.textContent = chat.team ? 'TEAM' : 'ALL';
  chat.scopeLabel.classList.toggle('team', chat.team);
}

export function chatIsOpen(chat) {
  return chat.open;
}

/** Whether team chat is meaningful in the current mode. */
export function setTeamChatAvailable(chat, available) {
  chat.teamMode = available;
  if (!available) setScope(chat, false);
}

export function openChat(chat, { team = false } = {}) {
  if (chat.open) return;
  chat.open = true;
  setScope(chat, team);
  chat.compose.classList.remove('hidden');
  chat.root.classList.add('active');
  // Focus has to come after the element is displayed or it silently does nothing.
  requestAnimationFrame(() => chat.input.focus());
  chat.onOpenChange?.(true);
}

export function close(chat) {
  if (!chat.open) return;
  chat.open = false;
  chat.compose.classList.add('hidden');
  chat.root.classList.remove('active');
  chat.input.blur();
  chat.onOpenChange?.(false);
}

export function addChatLine(chat, msg, myId) {
  const line = document.createElement('div');
  line.className = 'chat-line';

  if (msg.system) {
    line.classList.add('system');
    line.textContent = msg.text;
  } else {
    if (msg.id === myId) line.classList.add('mine');

    if (msg.teamOnly) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '[TEAM]';
      line.appendChild(tag);
    }

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${msg.name}: `;
    line.appendChild(who);

    // textContent, never innerHTML — this is text from other people.
    const body = document.createElement('span');
    body.textContent = msg.text;
    line.appendChild(body);
  }

  chat.log.appendChild(line);
  while (chat.log.children.length > MAX_LINES) chat.log.firstChild.remove();

  // Un-fade briefly so a new message is readable even if you're not typing.
  chat.root.classList.add('recent');
  clearTimeout(chat.recentTimer);
  chat.recentTimer = setTimeout(() => chat.root.classList.remove('recent'), FADE_AFTER_MS);
}

export function clearChat(chat) {
  chat.log.replaceChildren();
  close(chat);
}
