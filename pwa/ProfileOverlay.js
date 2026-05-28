// ProfileOverlay.js — Claudio 音乐品味主页浮层卡片

const ProfileOverlay = (() => {
  let overlay = null;

  const DECLARATIONS = [
    'yy的私人dj，会打碟的taste.md \u{1F3A7}',
    'Your mood is my prompt.',
    'I hate algorithm. I have taste.',
  ];

  const GENRES = [
    '华语流行',
    'R&B',
    'Jazz-HipHop',
    'Indie-Pop',
    'Folk-Rock',
    'K-Pop',
    'Taylor Swift',
    '下雨白噪音',
    'Ambient',
  ];

  const STATS = [
    { label: 'ON AIR',  value: '24/7' },
    { label: 'GENRES',  value: '∞' },
    { label: 'LISTENER', value: '1' },
  ];

  function create() {
    overlay = document.createElement('div');
    overlay.id = 'profile-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'profile-backdrop';
    backdrop.addEventListener('click', close);

    const card = document.createElement('div');
    card.className = 'profile-card';

    // 核心头部
    const header = document.createElement('div');
    header.className = 'profile-header';

    const avatar = document.createElement('img');
    avatar.className = 'profile-avatar';
    avatar.src = 'mike.jpg';
    avatar.alt = 'Claudio';

    const headerText = document.createElement('div');
    headerText.className = 'profile-header-text';

    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = 'Claudio';

    const slogan = document.createElement('div');
    slogan.className = 'profile-slogan';
    slogan.textContent = '举起你的手放纵你狂跳的脉搏';

    headerText.appendChild(name);
    headerText.appendChild(slogan);
    header.appendChild(avatar);
    header.appendChild(headerText);

    // 宣言
    const declarations = document.createElement('div');
    declarations.className = 'profile-declarations';
    DECLARATIONS.forEach(text => {
      const line = document.createElement('div');
      line.className = 'profile-dec-line';
      line.textContent = text;
      declarations.appendChild(line);
    });

    // 分隔线
    const divider = document.createElement('hr');
    divider.className = 'profile-divider';

    // 统计
    const statsRow = document.createElement('div');
    statsRow.className = 'profile-stats';
    STATS.forEach(s => {
      const slot = document.createElement('div');
      slot.className = 'profile-stat-slot';
      const label = document.createElement('div');
      label.className = 'profile-stat-label';
      label.textContent = s.label;
      const value = document.createElement('div');
      value.className = 'profile-stat-value';
      value.textContent = s.value;
      slot.appendChild(label);
      slot.appendChild(value);
      statsRow.appendChild(slot);
    });

    // 标签
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'profile-genres';
    GENRES.forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'profile-genre-tag';
      tag.textContent = g;
      tagsWrap.appendChild(tag);
    });

    card.appendChild(header);
    card.appendChild(declarations);
    card.appendChild(divider);
    card.appendChild(statsRow);
    card.appendChild(tagsWrap);

    overlay.appendChild(backdrop);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function open(e) {
    if (!overlay) create();
    const avatar = e ? e.target : document.querySelector('.logo-avatar');
    const rect = avatar.getBoundingClientRect();
    const card = overlay.querySelector('.profile-card');
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    card.style.transformOrigin = `${cx}px ${cy}px`;
    overlay.classList.add('open');
  }

  function close() {
    if (!overlay) return;
    const card = overlay.querySelector('.profile-card');
    card.style.animation = 'profile-card-out 0.25s cubic-bezier(0.55, 0, 1, 0.45) forwards';
    overlay.querySelector('.profile-backdrop').style.animation = 'profile-backdrop-out 0.25s ease forwards';
    setTimeout(() => {
      overlay.classList.remove('open');
      card.style.animation = '';
      overlay.querySelector('.profile-backdrop').style.animation = '';
    }, 250);
  }

  return { open, close };
})();
