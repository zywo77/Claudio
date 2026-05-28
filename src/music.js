// ── NeteaseCloudMusicApi 封装 ──
// 直接调用 NeteaseCloudMusicApi 包的函数，无需单独启动服务器

const ncm = require('NeteaseCloudMusicApi');
const NCM_COOKIE = process.env.NCM_COOKIE || '';

// 通用请求选项
function opts(extra = {}) {
  return { cookie: NCM_COOKIE, ...extra };
}

// ── 搜索歌曲 ──
async function search(keyword, { limit = 5, type = 1 } = {}) {
  const res = await ncm.search(opts({ keywords: keyword, type, limit }));
  const songs = res.body.result?.songs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artist: s.artists?.map(a => a.name).join(' / ') || s.ar?.map(a => a.name).join(' / ') || '未知',
    album: s.album?.name || s.al?.name || '',
    duration: s.duration || 0,
    cover: s.album?.artist?.img1v1Url || s.al?.picUrl || '',
  }));
}

// ── 获取歌曲直链 URL ──
async function songUrl(id) {
  const res = await ncm.song_url_v1(opts({ id, level: 'standard' }));
  const data = res.body.data?.[0];
  return {
    url: data?.url || '',
    br: data?.br || 0,
    size: data?.size || 0,
    type: data?.type || '',
  };
}

// ── 获取歌词 ──
async function lyric(id) {
  const res = await ncm.lyric(opts({ id }));
  return {
    lyric: res.body.lrc?.lyric || '',
    tlyric: res.body.tlyric?.lyric || '',
  };
}

// ── 个性化推荐（每日推荐歌曲） ──
async function recommend() {
  const res = await ncm.recommend_songs(opts());
  const songs = res.body.data?.dailySongs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artist: s.ar?.map(a => a.name).join(' / ') || '未知',
    album: s.al?.name || '',
    duration: s.dt || 0,
    cover: s.al?.picUrl || '',
    reason: s.reason || '',
  }));
}

// ── 推荐歌单 ──
async function recommendResource() {
  const res = await ncm.recommend_resource(opts());
  return (res.body.recommend || []).map(p => ({
    id: p.id,
    name: p.name,
    cover: p.picUrl || '',
    playcount: p.playcount || 0,
    reason: p.reason || '',
  }));
}

// ── 批量获取歌曲详情 ──
async function detail(ids) {
  if (!ids || ids.length === 0) return [];
  const idStr = Array.isArray(ids) ? ids.join(',') : String(ids);
  const res = await ncm.song_detail(opts({ ids: idStr }));
  return (res.body.songs || []).map(s => ({
    id: s.id,
    name: s.name,
    artist: s.ar?.map(a => a.name).join(' / ') || '未知',
    album: s.al?.name || '',
    duration: s.dt || 0,
    cover: s.al?.picUrl || '',
  }));
}

// ── 拉取用户全部歌单 ──
async function playlistAll(uid) {
  const res = await ncm.user_playlist(opts({ uid }));
  return (res.body.playlist || []).map(p => ({
    id: p.id,
    name: p.name,
    trackCount: p.trackCount || 0,
    cover: p.coverImgUrl || '',
    playcount: p.playcount || 0,
  }));
}

// ── 歌单全部歌曲 ──
async function playlistTracks(playlistId) {
  const res = await ncm.playlist_track_all(opts({ id: playlistId }));
  return (res.body.songs || []).map(s => ({
    id: s.id,
    name: s.name,
    artist: s.ar?.map(a => a.name).join(' / ') || '未知',
    album: s.al?.name || '',
    duration: s.dt || 0,
    cover: s.al?.picUrl || '',
  }));
}

// ── 私人FM ──
async function personalFm() {
  const res = await ncm.personal_fm(opts());
  return (res.body.data || []).map(s => ({
    id: s.id,
    name: s.name,
    artist: s.artists?.map(a => a.name).join(' / ') || s.ar?.map(a => a.name).join(' / ') || '未知',
    album: s.album?.name || s.al?.name || '',
    duration: s.duration || s.dt || 0,
    cover: s.album?.picUrl || s.al?.picUrl || '',
  }));
}

// ── 最近播放记录 ──
async function recentSong() {
  const res = await ncm.record_recent_song(opts({ limit: 50 }));
  return (res.body.data?.list || []).map(item => {
    const s = item.data;
    return {
      id: s.id,
      name: s.name,
      artist: s.ar?.map(a => a.name).join(' / ') || '未知',
      album: s.al?.name || '',
      duration: s.dt || 0,
      cover: s.al?.picUrl || '',
      playTime: item.playTime || 0,
    };
  });
}

// ── 登录状态检查 ──
async function loginStatus() {
  try {
    const res = await ncm.login_status(opts());
    const profile = res.body.data?.profile;
    if (profile) {
      return {
        logged: true,
        uid: profile.userId,
        nickname: profile.nickname,
        avatar: profile.avatarUrl,
        vipType: profile.vipType,
      };
    }
    return { logged: false };
  } catch {
    return { logged: false };
  }
}

module.exports = {
  search, songUrl, lyric, recommend, recommendResource,
  detail, playlistAll, playlistTracks, personalFm,
  recentSong, loginStatus,
};
