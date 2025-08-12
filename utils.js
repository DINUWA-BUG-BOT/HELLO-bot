const getRandom = (ext = '') => {
  return `${Math.floor(Math.random() * 10000000000000000)}${ext}`;
};
module.exports = { getRandom, getExtension };