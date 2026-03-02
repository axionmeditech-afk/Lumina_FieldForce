declare module "mappls-map-react-native" {
  import type { ComponentType } from "react";

  export const MapView: ComponentType<any>;
  export const Camera: ComponentType<any>;
  export const ShapeSource: ComponentType<any>;
  export const LineLayer: ComponentType<any>;
  export const PointAnnotation: ComponentType<any>;

  export function setRegion(region: string): void;
  export function setClusterId(clusterId: string): void;

  const MapplsGL: {
    MapView: ComponentType<any>;
    Camera: ComponentType<any>;
    ShapeSource: ComponentType<any>;
    LineLayer: ComponentType<any>;
    PointAnnotation: ComponentType<any>;
    setRegion?: (region: string) => void;
    setClusterId?: (clusterId: string) => void;
  };

  export default MapplsGL;
}
