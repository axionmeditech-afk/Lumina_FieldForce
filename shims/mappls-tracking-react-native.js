const React = require("react");
const { View } = require("react-native");

const MapplsTrackingWidget = React.forwardRef(function MapplsTrackingWidget(_, ref) {
  React.useImperativeHandle(
    ref,
    () => ({
      startTracking: () => {},
    }),
    []
  );

  return React.createElement(View);
});

const sdk = {
  MapplsTrackingWidget,
};

module.exports = sdk;
module.exports.default = sdk;
