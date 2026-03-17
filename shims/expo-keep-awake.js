const noopAsync = async () => {};
const noop = () => {};

module.exports = {
  ExpoKeepAwakeTag: "ExpoKeepAwakeDefaultTag",
  isAvailableAsync: async () => false,
  useKeepAwake: noop,
  activateKeepAwake: noopAsync,
  activateKeepAwakeAsync: noopAsync,
  deactivateKeepAwake: noopAsync,
  addListener: () => ({ remove: noop }),
};
