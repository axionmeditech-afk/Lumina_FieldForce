const React = require("react");
const { View } = require("react-native");

function MapView(props) {
  return React.createElement(View, props, props.children);
}

function ShapeSource(props) {
  return React.createElement(React.Fragment, null, props.children);
}

function PointAnnotation(props) {
  return React.createElement(View, null, props.children);
}

function Noop() {
  return null;
}

const sdk = {
  setRegion: () => {},
  setClusterId: () => {},
  MapView,
  Camera: Noop,
  ShapeSource,
  LineLayer: Noop,
  PointAnnotation,
};

module.exports = sdk;
module.exports.default = sdk;
