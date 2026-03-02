declare module "mappls-tracking-react-native" {
  import type { ComponentType } from "react";

  export interface TrackingRequestData {
    currentLocation: [number, number];
    speedInMillis?: number;
    routeChangeBuffer?: number;
    latentViz?: "route" | "fly" | "jump";
    latentVizRadius?: number;
    cameraZoomLevel?: number;
    fitBoundsPadding?: number | number[];
    fitBoundsDuration?: number;
    simSpeed?: number;
    maxSimDis?: number;
    enableSim?: boolean;
  }

  export interface TrackingWidgetRef {
    startTracking: (trackingData: TrackingRequestData) => void;
    enableFitBounds: (fitBounds: boolean, padding?: number | number[]) => void;
    isVisibleRoutePolyline: (isVisible: boolean) => void;
    removeCurveLine: (remove: boolean) => void;
    enableDestinationConnectorLine: (enable: boolean) => void;
    enableFakeSimulation: (enable: boolean) => void;
  }

  export interface TrackingWidgetProps {
    orderId: string;
    originPoint: string;
    destinationPoint: string;
    speedInMillis: number;
    routePolylineStyle: Record<string, unknown>;
    dashRoutePolylineStyle: Record<string, unknown>;
    destinationIconStyle: Record<string, unknown>;
    OriginIconStyle: Record<string, unknown>;
    destinationRouteConnectorStyle: Record<string, unknown>;
    profile?: string;
    resource?: string;
    routeChangeBuffer?: number;
    latentViz?: "route" | "fly" | "jump";
    polylineRefresh?: boolean;
    cameraZoomLevel?: number;
    fitBoundsPadding?: number | number[];
    fitBoundsDuration?: number;
    latentVizRadius?: number;
    enableDestinationRouteConnector?: boolean;
    trackingIcon?: string;
    trackingIconSize?: number;
    trackingSegmentCompleteCallback?: (event: unknown) => void;
    trackingEventCallback?: (eventName: string, eventValue: string) => void;
    [key: string]: unknown;
  }

  export const MapplsTrackingWidget: ComponentType<TrackingWidgetProps & { ref?: unknown }>;

  const MapplsTracking: {
    MapplsTrackingWidget: ComponentType<TrackingWidgetProps & { ref?: unknown }>;
  };

  export default MapplsTracking;
}
