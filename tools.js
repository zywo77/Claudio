// 模拟获取音乐播放列表的工具
const getMusicList = (mood) => {
  const songs = {
    'happy': ['阳光总在风雨后', 'Happy'],
    'nostalgic': ['昨日重现', '那些年']
  };
  return songs[mood] || ['默认歌单'];
};