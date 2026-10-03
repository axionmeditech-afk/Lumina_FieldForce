import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import WebView from 'react-native-webview';
import type { Coordinate, HaltRecord, RoutePoint } from '../types';
import { fieldTrackingConfig as appConfig } from '../config';
import { haversineMetres } from '../geo';

type MapPayload = {
  plannedRoute: Coordinate[];
  travelledRoute: Coordinate[];
  destination: Coordinate | null;
  halts: Pick<HaltRecord, 'id' | 'latitude' | 'longitude' | 'status'>[];
  waypoints: Coordinate[];
  position: Coordinate | null;
  start: Coordinate | null;
  accuracy: number | null;
  progressPercent: number;
  follow: boolean;
  previewRoute: boolean;
  navigationActive: boolean;
  heading: number | null;
};

export function RouteMap({
  points,
  matchedRoute = [],
  matchedRouteSource = 'raw',
  waypoints = [],
  follow = true,
  compact: _compact = false,
  plannedRoute = [],
  destination,
  progressPercent = 0,
  halts = [],
  snappedPosition,
  navigationActive = false,
  previewRoute = false,
  heading = null
}: {
  points: RoutePoint[];
  matchedRoute?: Coordinate[];
  matchedRouteSource?: 'self-hosted-valhalla' | 'raw';
  waypoints?: Coordinate[];
  follow?: boolean;
  compact?: boolean;
  plannedRoute?: Coordinate[];
  destination?: Coordinate | null;
  progressPercent?: number;
  halts?: HaltRecord[];
  snappedPosition?: Coordinate | null;
  navigationActive?: boolean;
  previewRoute?: boolean;
  heading?: number | null;
}) {
  const webRef = useRef<WebView>(null);
  const [rendererStatus, setRendererStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const eligible = useMemo(() => points.filter((point) => point.routeEligible), [points]);
  const trusted = useMemo(
    () => points.filter((point) => point.routeEligible || point.rejectionReason === 'stationary_noise'),
    [points]
  );
  const latest = trusted.at(-1);
  const displayTravelRoute = useMemo(
    () => mergeTravelTrail(compactRawTrace(eligible), matchedRouteSource === 'self-hosted-valhalla' ? matchedRoute : []),
    [eligible, matchedRoute, matchedRouteSource]
  );
  const start = useMemo(
    () => eligible[0] ? { latitude: eligible[0].latitude, longitude: eligible[0].longitude } : null,
    [eligible],
  );
  const position = useMemo(
    () => navigationActive && snappedPosition
      ? snappedPosition
      : latest
        ? { latitude: latest.latitude, longitude: latest.longitude }
        : null,
    [latest, navigationActive, snappedPosition],
  );
  const previewSnappedPosition = useMemo(
    () => previewRoute && !navigationActive && position
      ? snapToPlannedRoute(position, plannedRoute, Math.max(50, Math.min(120, (latest?.accuracy ?? 35) * 1.7)))
      : null,
    [latest?.accuracy, navigationActive, plannedRoute, position, previewRoute]
  );
  const mapPosition = previewSnappedPosition ?? position;

  const payload = useMemo<MapPayload>(() => ({
    plannedRoute: thinRoute(plannedRoute),
    travelledRoute: displayTravelRoute,
    destination: destination ?? null,
    halts: halts.map(({ id, latitude, longitude, status }) => ({ id, latitude, longitude, status })),
    waypoints,
    position: mapPosition,
    start,
    accuracy: latest?.accuracy ?? null,
    progressPercent,
    follow,
    previewRoute,
    navigationActive,
    heading: heading != null && Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading : null
  }), [plannedRoute, displayTravelRoute, destination, halts, waypoints, mapPosition, start, latest?.accuracy, progressPercent, follow, previewRoute, navigationActive, heading]);

  useEffect(() => {
    if (rendererStatus === 'ready') webRef.current?.postMessage(JSON.stringify({ type: 'map_state', payload }));
  }, [payload, rendererStatus]);

  const html = useMemo(() => createMapHtml(appConfig.osmTileUrl), []);

  return (
    <View style={styles.frame}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        applicationNameForUserAgent="LuminaFieldForce/1.0"
        geolocationEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        onError={() => setRendererStatus('error')}
        onLoadEnd={() => webRef.current?.postMessage(JSON.stringify({ type: 'map_state', payload }))}
        onMessage={(event) => {
          if (event.nativeEvent.data === 'map_ready') setRendererStatus('ready');
          if (event.nativeEvent.data === 'map_error') setRendererStatus('error');
        }}
        style={styles.webview}
      />
      {rendererStatus !== 'ready' ? (
        <View pointerEvents="none" style={styles.statusPill}>
          <Text style={styles.statusText}>{rendererStatus === 'error' ? 'Map renderer is unavailable. Check internet connection.' : 'Loading field map...'}</Text>
        </View>
      ) : null}
      <View pointerEvents="box-none" style={styles.attribution}>
        <Text
          accessibilityRole="link"
          onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright')}
          style={styles.attributionText}
        >
          {'© OpenStreetMap contributors'}
        </Text>
      </View>
    </View>
  );
}

function compactRawTrace(points: RoutePoint[]): Coordinate[] {
  const accepted = points.filter((point) => point.accuracy != null && point.accuracy <= 45);
  const candidates = accepted.length >= 2 ? accepted : points;
  if (candidates.length < 3) return candidates.map(({ latitude, longitude }) => ({ latitude, longitude }));

  const compact: Coordinate[] = [];
  for (const point of candidates) {
    const coordinate = { latitude: point.latitude, longitude: point.longitude };
    const previous = compact.at(-1);
    const threshold = Math.max(8, Math.min(18, (point.accuracy ?? 25) * 0.4));
    if (!previous || haversineMetres(previous, coordinate) >= threshold) compact.push(coordinate);
  }
  const finalPoint = candidates.at(-1)!;
  const finalCoordinate = { latitude: finalPoint.latitude, longitude: finalPoint.longitude };
  if (!compact.length || haversineMetres(compact.at(-1)!, finalCoordinate) > 1) compact.push(finalCoordinate);
  return thinRoute(compact);
}

function mergeTravelTrail(raw: Coordinate[], matched: Coordinate[]): Coordinate[] {
  if (matched.length < 2) return thinRoute(raw);
  if (raw.length < 2) return thinRoute(matched);
  const firstMatched = matched[0]!;
  let spliceIndex = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < raw.length; index += 1) {
    const distance = haversineMetres(raw[index]!, firstMatched);
    if (distance < nearest) {
      nearest = distance;
      spliceIndex = index;
    }
  }
  return thinRoute([...raw.slice(0, spliceIndex), ...matched]);
}

// The native audit trail can contain many thousands of points. The WebView
// only needs a visually faithful sample; limiting its bridge payload prevents
// GC pauses and SVG work during a long shift while retaining both endpoints.
function thinRoute(points: Coordinate[], maxPoints = 700): Coordinate[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]!);
}

function snapToPlannedRoute(position: Coordinate, route: Coordinate[], maxDistanceMetres: number): Coordinate | null {
  if (route.length < 2) return null;
  let nearest: Coordinate | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const longitudeScale = Math.cos(position.latitude * Math.PI / 180);
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1]!;
    const to = route[index]!;
    const x = (position.longitude - from.longitude) * longitudeScale;
    const y = position.latitude - from.latitude;
    const dx = (to.longitude - from.longitude) * longitudeScale;
    const dy = to.latitude - from.latitude;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0 ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
    const candidate = { latitude: from.latitude + (to.latitude - from.latitude) * fraction, longitude: from.longitude + (to.longitude - from.longitude) * fraction };
    const distance = haversineMetres(position, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= maxDistanceMetres ? nearest : null;
}

function createMapHtml(tileUrl: string): string {
  const safeTileUrl = JSON.stringify(tileUrl).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
html,body,#map{width:100%;height:100%;margin:0;overflow:hidden;background:#e9eef5;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
#map{position:relative;touch-action:none}
.scene{position:absolute;inset:0;transform-origin:50% 50%;will-change:transform}
.tile-layer{position:absolute;inset:0;overflow:visible}
.marker-layer,.route-layer{position:absolute;inset:0;overflow:hidden}
.tile-grid{position:absolute;inset:0;overflow:visible;will-change:transform}
.tile{position:absolute;width:256px;height:256px;user-select:none;pointer-events:none}
.route-layer{pointer-events:none}
.pin{position:absolute;transform:translate(-50%,-50%);pointer-events:none}
.start{width:14px;height:14px;border-radius:50%;background:#109d84;border:3px solid #fff;box-shadow:0 2px 8px rgba(12,48,41,.35)}
.current{width:44px;height:44px;border:0;border-radius:50%;background:rgba(47,128,237,.14);transform:translate(-50%,-50%) rotate(var(--marker-heading,0deg));box-shadow:0 0 0 1px rgba(47,128,237,.35),0 4px 14px rgba(12,36,80,.26)}
.current:before{content:'';position:absolute;inset:6px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(12,36,80,.18)}
.current:after{content:'';position:absolute;left:9px;top:7px;width:26px;height:30px;background:linear-gradient(145deg,#57a5ff 0%,#1d5fd1 68%,#17489f 100%);clip-path:polygon(50% 0%,96% 88%,50% 69%,4% 88%);filter:drop-shadow(0 1px 1px rgba(12,36,80,.24))}
.halt{width:12px;height:12px;border-radius:50%;border:3px solid #fff;background:#f29900;box-shadow:0 2px 7px rgba(80,48,0,.3)}
.halt.active{background:#ea6d00}
.waypoint{width:17px;height:17px;border-radius:50%;background:#ffffff;border:4px solid #286be6;box-shadow:0 2px 8px rgba(12,36,80,.28)}
.destination{width:19px;height:19px;border-radius:50% 50% 50% 0;background:#e5484d;border:3px solid #fff;transform:translate(-50%,-85%) rotate(-45deg);box-shadow:0 2px 8px rgba(90,18,22,.35)}
.control{position:absolute;right:12px;z-index:5;border:0;width:40px;height:40px;border-radius:12px;background:#fff;color:#1d2939;font-size:25px;font-weight:600;line-height:40px;box-shadow:0 3px 10px rgba(16,24,40,.22)}
.zoom.in{top:220px}.zoom.out{top:266px}.locate{top:318px;font-size:19px}
.control:active{background:#e9f0ff}
</style></head><body><div id="map"><div class="scene" id="scene"><div class="tile-layer"><div class="tile-grid" id="tiles"></div></div><svg class="route-layer" id="routes"></svg><div class="marker-layer" id="markers"></div></div><button class="control zoom in" id="plus" aria-label="Zoom in">+</button><button class="control zoom out" id="minus" aria-label="Zoom out">-</button><button class="control locate" id="locate" aria-label="Center on current location">&#9673;</button></div><script>
(function(){
var tileUrl=${safeTileUrl},TILE=256;
var root=document.getElementById('map'),scene=document.getElementById('scene'),tiles=document.getElementById('tiles'),routes=document.getElementById('routes'),markers=document.getElementById('markers');
var target={lat:23.049,lon:72.55,zoom:13,bearing:0};
var cam={lat:23.049,lon:72.55,zoom:13,bearing:0};
var state=null,fittedPreview=false,lastPreviewKey='',following=true,manualBearing=null;
var drag=null,pointers={},pinch=null,gesturing=false;
var tileNodes={},animating=false,lastTick=null;
var EASE=7;
function post(message){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(message)}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
function normalizeBearing(value){return((value%360)+360)%360}
function headingDelta(from,to){return((to-from+540)%360)-180}
function worldSize(zoom){return TILE*Math.pow(2,zoom)}
function project(lat,lon,zoom){var size=worldSize(zoom),safeLat=clamp(lat,-85.05112878,85.05112878);return{x:(lon+180)/360*size,y:(1-Math.log(Math.tan(safeLat*Math.PI/180)+1/Math.cos(safeLat*Math.PI/180))/Math.PI)/2*size}}
function unproject(x,y,zoom){var size=worldSize(zoom),lon=x/size*360-180,n=Math.PI-2*Math.PI*y/size;return{lat:180/Math.PI*Math.atan(.5*(Math.exp(n)-Math.exp(-n))),lon:lon}}
function metresToPixels(metres,lat,zoom){return metres/(156543.03392*Math.cos(lat*Math.PI/180)/Math.pow(2,zoom))}
function viewport(){return{w:root.clientWidth||360,h:root.clientHeight||640}}
function screen(point){var view=viewport(),c=project(cam.lat,cam.lon,cam.zoom),p=project(point.latitude,point.longitude,cam.zoom);return{x:p.x-c.x+view.w/2,y:p.y-c.y+view.h/2}}
function rotateVector(x,y,degrees){var radians=degrees*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians);return{x:x*cos-y*sin,y:x*sin+y*cos}}
function sceneMetrics(){
  var view=viewport(),planned=state?state.__planned:null,navMode=!!(state&&state.navigationActive),previewMode=!!(state&&!navMode&&state.previewRoute&&planned&&planned.length>1);
  // A navigation puck sits below centre so the road ahead remains visible.
  // This is a screen-space presentation offset, never a geographic offset.
  var anchorRatio=navMode ? .62 : (previewMode ? .57 : .5),shiftY=(anchorRatio-.5)*view.h,radians=cam.bearing*Math.PI/180,cos=Math.abs(Math.cos(radians)),sin=Math.abs(Math.sin(radians));
  // Exact cover calculation for a rotated, translated non-square viewport.
  var horizontalScale=view.w/(cos*view.w+sin*view.h),verticalScale=(view.h+2*Math.abs(shiftY))/(sin*view.w+cos*view.h);
  return{shiftY:shiftY,scale:Math.max(horizontalScale,verticalScale)*1.028}
}
function screenDeltaToWorld(dx,dy){var metrics=sceneMetrics();return rotateVector(dx/metrics.scale,dy/metrics.scale,cam.bearing)}
function worldAt(screenPoint){var view=viewport(),c=project(cam.lat,cam.lon,cam.zoom),metrics=sceneMetrics(),offset=screenDeltaToWorld(screenPoint.x-view.w/2,screenPoint.y-view.h/2-metrics.shiftY);return{x:c.x+offset.x,y:c.y+offset.y}}
function pointerList(){var list=[];for(var id in pointers)list.push(pointers[id]);return list}
function pointDistance(a,b){var dx=a.x-b.x,dy=a.y-b.y;return Math.sqrt(dx*dx+dy*dy)}
function pointMidpoint(a,b){return{x:(a.x+b.x)/2,y:(a.y+b.y)/2}}
function valid(point){return point&&Number.isFinite(point.latitude)&&Number.isFinite(point.longitude)}
function points(items){return(items||[]).filter(valid)}

function ensureAnimating(){if(!animating){animating=true;lastTick=null;window.requestAnimationFrame(tick)}}
function tick(ts){
  if(lastTick==null)lastTick=ts;
  var dt=Math.min(0.12,Math.max(0,(ts-lastTick)/1000));
  lastTick=ts;
  var stillMoving=false;
  if(!gesturing){
    var factor=1-Math.exp(-EASE*dt);
    var dLat=target.lat-cam.lat,dLon=target.lon-cam.lon,dBearing=headingDelta(cam.bearing,target.bearing);
    if(Math.abs(dLat)>1e-9||Math.abs(dLon)>1e-9){cam.lat+=dLat*factor;cam.lon+=dLon*factor}
    if(Math.abs(dBearing)>1e-3){cam.bearing=normalizeBearing(cam.bearing+dBearing*factor)}
    if(cam.zoom!==target.zoom)cam.zoom=target.zoom;
    if(Math.abs(target.lat-cam.lat)<1e-9)cam.lat=target.lat;
    if(Math.abs(target.lon-cam.lon)<1e-9)cam.lon=target.lon;
    if(Math.abs(headingDelta(cam.bearing,target.bearing))<1e-3)cam.bearing=target.bearing;
    stillMoving=cam.lat!==target.lat||cam.lon!==target.lon||cam.bearing!==target.bearing
  }
  renderFrame();
  if(stillMoving||gesturing)window.requestAnimationFrame(tick);else animating=false
}

function renderTiles(){
  var view=viewport(),metrics=sceneMetrics(),radians=cam.bearing*Math.PI/180,cos=Math.abs(Math.cos(radians)),sin=Math.abs(Math.sin(radians)),localWidth=(cos*view.w+sin*view.h)/metrics.scale,localHeight=(sin*view.w+cos*view.h)/metrics.scale,shiftX=Math.abs(Math.sin(radians)*metrics.shiftY)/metrics.scale,shiftY=Math.abs(Math.cos(radians)*metrics.shiftY)/metrics.scale,padX=Math.max(2,Math.ceil((Math.max(0,localWidth-view.w)/2+shiftX)/TILE)+2),padY=Math.max(2,Math.ceil((Math.max(0,localHeight-view.h)/2+shiftY)/TILE)+2),tileZoom=clamp(Math.round(cam.zoom),3,19),c=project(cam.lat,cam.lon,tileZoom),left=c.x-view.w/2,top=c.y-view.h/2;
  var startX=Math.floor(left/TILE)-1,endX=Math.floor((left+view.w)/TILE)+1,startY=Math.floor(top/TILE)-1,endY=Math.floor((top+view.h)/TILE)+1,max=Math.pow(2,tileZoom),keep={};
  for(var y=startY-padY;y<=endY+padY;y++){
    if(y<0||y>=max)continue;
    for(var x=startX-padX;x<=endX+padX;x++){
      var wrapped=((x%max)+max)%max,key=tileZoom+'/'+x+'/'+y,node=tileNodes[key];
      keep[key]=true;
      if(!node){node=document.createElement('img');node.className='tile';node.draggable=false;node.decoding='async';node.src=tileUrl.replace('{z}',tileZoom).replace('{x}',wrapped).replace('{y}',y);tiles.appendChild(node);tileNodes[key]=node}
      node.style.left=((x-startX)*TILE)+'px';node.style.top=((y-startY)*TILE)+'px'
    }
  }
  for(var oldKey in tileNodes){if(!keep[oldKey]){tiles.removeChild(tileNodes[oldKey]);delete tileNodes[oldKey]}}
  tiles.style.transform='translate3d('+((startX*TILE)-left)+'px,'+((startY*TILE)-top)+'px,0)'
}

function polyline(items,stroke,width,dash){
  var list=points(items);
  if(list.length>900){var step=Math.ceil(list.length/900),reduced=[];for(var index=0;index<list.length;index+=step)reduced.push(list[index]);if(reduced[reduced.length-1]!==list[list.length-1])reduced.push(list[list.length-1]);list=reduced}
  if(list.length<2)return '';
  return'<polyline points="'+list.map(function(point){var p=screen(point);return p.x+','+p.y}).join(' ')+'" fill="none" stroke="'+stroke+'" stroke-width="'+width+'" stroke-linecap="round" stroke-linejoin="round" '+(dash?'stroke-dasharray="'+dash+'"':'')+' />'
}
function splitRoute(route,percent){if(route.length<2)return route;return route.slice(Math.max(1,Math.round(route.length*clamp(percent,0,100)/100)-1))}
function marker(point,className,heading){
  if(!valid(point))return '';
  var p=screen(point),style='left:'+p.x+'px;top:'+p.y+'px';
  if(className==='current')style+=';--marker-heading:'+(Number.isFinite(heading)?heading:0)+'deg';
  return'<div class="pin '+className+'" style="'+style+'"></div>'
}
function renderLayers(){
  if(!state)return;
  var planned=points(state.plannedRoute),trail=points(state.travelledRoute),position=state.position,svg='';
  if(planned.length>1){svg+=polyline(planned,'#ffffff',10)+polyline(planned,'#4a5fd4',6)+polyline(splitRoute(planned,state.progressPercent||0),'#243fce',6)}
  if(trail.length>1)svg+=polyline(trail,'#ffffff',8)+polyline(trail,'#119B87',4.5);
  if(valid(position)&&Number.isFinite(state.accuracy)&&state.accuracy>0&&state.accuracy<=150){
    var cp=screen(position),radius=Math.max(8,metresToPixels(state.accuracy,position.latitude,cam.zoom));
    svg+='<circle cx="'+cp.x+'" cy="'+cp.y+'" r="'+radius+'" fill="#286be6" fill-opacity=".12" stroke="#286be6" stroke-opacity=".35" stroke-width="1" />'
  }
  routes.setAttribute('width',viewport().w);routes.setAttribute('height',viewport().h);routes.innerHTML=svg;
  var html=marker(state.start,'start');
  (state.waypoints||[]).forEach(function(stop){html+=marker(stop,'waypoint')});
  (state.halts||[]).forEach(function(halt){html+=marker(halt,'halt '+(halt.status==='ongoing'?'active':''))});
  html+=marker(state.destination,'destination')+marker(position,'current',state.heading);
  markers.innerHTML=html
}
function updateSceneTransform(){var metrics=sceneMetrics();scene.style.transform='translate3d(0,'+metrics.shiftY.toFixed(2)+'px,0) rotate('+(-cam.bearing)+'deg) scale('+metrics.scale.toFixed(4)+')'}
function renderFrame(){renderTiles();renderLayers();updateSceneTransform()}

function fitRouteTarget(route){
  var list=points(route);if(list.length<2)return null;
  var view=viewport();
  var minLat=Math.min.apply(null,list.map(function(p){return p.latitude})),maxLat=Math.max.apply(null,list.map(function(p){return p.latitude}));
  var minLon=Math.min.apply(null,list.map(function(p){return p.longitude})),maxLon=Math.max.apply(null,list.map(function(p){return p.longitude}));
  var found=3;
  for(var candidate=19;candidate>=3;candidate--){
    var a=project(minLat,minLon,candidate),b=project(maxLat,maxLon,candidate);
    found=candidate;
    if(Math.abs(b.x-a.x)<=view.w-88&&Math.abs(b.y-a.y)<=view.h-180)break
  }
  return{lat:(minLat+maxLat)/2,lon:(minLon+maxLon)/2,zoom:found}
}

function apply(next){
  var previous=state;
  state=next;
  if(!previous)following=state.follow;
  if(!state.follow)following=false;
  if(previous&&!previous.follow&&state.follow)following=true;
  var planned=points(state.plannedRoute);
  var previewKey=planned.length?planned.length+':'+planned[0].latitude.toFixed(5)+':'+planned[0].longitude.toFixed(5)+':'+planned[planned.length-1].latitude.toFixed(5)+':'+planned[planned.length-1].longitude.toFixed(5):'';
  var navigationJustStarted=previous&&!previous.navigationActive&&state.navigationActive;
  var previewRouteChanged=state.previewRoute&&previewKey!==lastPreviewKey;
  if(previewRouteChanged){fittedPreview=false;lastPreviewKey=previewKey}
  if(navigationJustStarted){following=true;fittedPreview=false;manualBearing=null}

  var snapCamera=false;

  if(state.previewRoute&&planned.length>1&&!fittedPreview){
    if(valid(state.position)){target={lat:state.position.latitude,lon:state.position.longitude,zoom:17,bearing:0}}
    else{var fit=fitRouteTarget(planned);if(fit)target={lat:fit.lat,lon:fit.lon,zoom:fit.zoom,bearing:0}}
    fittedPreview=true;snapCamera=true
  }else if(following&&valid(state.position)){
    var isPreview=state.previewRoute&&planned.length>1;
    var targetZoom=state.navigationActive?18:(isPreview?17:16);
    var targetBearing=state.navigationActive&&manualBearing==null&&Number.isFinite(state.heading)?state.heading:(manualBearing!=null?manualBearing:0);
    var shouldUpdate;
    if(state.navigationActive||isPreview){shouldUpdate=true}
    else shouldUpdate=true;
    if(shouldUpdate){
      target={lat:state.position.latitude,lon:state.position.longitude,zoom:targetZoom,bearing:targetBearing}
    }
    if(navigationJustStarted)snapCamera=true;
  }else if(!state.position&&state.destination&&!fittedPreview){
    target={lat:state.destination.latitude,lon:state.destination.longitude,zoom:15,bearing:0};
    fittedPreview=true;snapCamera=true
  }

  if(snapCamera){cam.lat=target.lat;cam.lon=target.lon;cam.zoom=target.zoom;cam.bearing=target.bearing}
  ensureAnimating()
}

function receive(raw){try{var message=JSON.parse(raw);if(message.type==='map_state')apply(message.payload)}catch(_){}}

function centerOnPosition(){
  if(!state||!valid(state.position))return;
  following=true;manualBearing=null;
  var planned=points(state.plannedRoute),isPreview=state.previewRoute&&planned.length>1;
  var targetZoom=state.navigationActive?18:(isPreview?17:16);
  var targetBearing=state.navigationActive&&Number.isFinite(state.heading)?state.heading:0;
  target={lat:state.position.latitude,lon:state.position.longitude,zoom:targetZoom,bearing:targetBearing};
  ensureAnimating()
}

function zoomAroundInstant(nextZoom,anchor,screenPoint){
  nextZoom=clamp(nextZoom,3,19);
  if(nextZoom===cam.zoom)return;
  var view=viewport(),anchorWorld=project(anchor.lat,anchor.lon,nextZoom),metrics=sceneMetrics(),offset=screenDeltaToWorld(screenPoint.x-view.w/2,screenPoint.y-view.h/2-metrics.shiftY),centerWorld={x:anchorWorld.x-offset.x,y:anchorWorld.y-offset.y};
  var newCenter=unproject(centerWorld.x,centerWorld.y,nextZoom);
  cam.lat=newCenter.lat;cam.lon=newCenter.lon;cam.zoom=nextZoom;
  target.lat=cam.lat;target.lon=cam.lon;target.zoom=cam.zoom;target.bearing=cam.bearing
}
function startPinch(){
  var list=pointerList();if(list.length<2)return;
  var mid=pointMidpoint(list[0],list[1]),anchorWorld=worldAt(mid),anchor=unproject(anchorWorld.x,anchorWorld.y,cam.zoom),angle=Math.atan2(list[1].y-list[0].y,list[1].x-list[0].x);
  pinch={distance:Math.max(1,pointDistance(list[0],list[1])),anchor:anchor,angle:angle,bearing:cam.bearing};
  drag=null;following=false;fittedPreview=true
}
function resetDragFromRemaining(){
  var list=pointerList();
  if(list.length===1){var w=project(cam.lat,cam.lon,cam.zoom);drag={x:list[0].x,y:list[0].y,worldX:w.x,worldY:w.y}}
  else drag=null
}
root.addEventListener('pointerdown',function(event){
  if(event.target&&event.target.tagName==='BUTTON')return;
  event.preventDefault();
  pointers[event.pointerId]={x:event.clientX,y:event.clientY};
  root.setPointerCapture(event.pointerId);
  gesturing=true;ensureAnimating();
  if(pointerList().length===1)resetDragFromRemaining();else startPinch()
});
root.addEventListener('pointermove',function(event){
  if(!pointers[event.pointerId])return;
  event.preventDefault();
  pointers[event.pointerId]={x:event.clientX,y:event.clientY};
  var list=pointerList();
  if(list.length>=2){
    if(!pinch)startPinch();
    if(!pinch)return;
    var distance=pointDistance(list[0],list[1]),midpoint=pointMidpoint(list[0],list[1]),scale=distance/pinch.distance,angle=Math.atan2(list[1].y-list[0].y,list[1].x-list[0].x),twist=(angle-pinch.angle)*180/Math.PI;
    if(Math.abs(twist)>2){manualBearing=normalizeBearing(pinch.bearing-twist);cam.bearing=manualBearing;target.bearing=manualBearing}
    if(scale>=1.22){zoomAroundInstant(cam.zoom+1,pinch.anchor,midpoint);startPinch()}
    else if(scale<=.82){zoomAroundInstant(cam.zoom-1,pinch.anchor,midpoint);startPinch()}
    else{
      var anchorWorld=project(pinch.anchor.lat,pinch.anchor.lon,cam.zoom),view=viewport(),metrics=sceneMetrics(),offset=screenDeltaToWorld(midpoint.x-view.w/2,midpoint.y-view.h/2-metrics.shiftY),centerWorld={x:anchorWorld.x-offset.x,y:anchorWorld.y-offset.y};
      var newCenter=unproject(centerWorld.x,centerWorld.y,cam.zoom);
      cam.lat=newCenter.lat;cam.lon=newCenter.lon;target.lat=cam.lat;target.lon=cam.lon;target.zoom=cam.zoom;target.bearing=cam.bearing
    }
    return
  }
  if(!drag)return;
  var movement=screenDeltaToWorld(event.clientX-drag.x,event.clientY-drag.y),next=unproject(drag.worldX-movement.x,drag.worldY-movement.y,cam.zoom);
  cam.lat=next.lat;cam.lon=next.lon;target.lat=cam.lat;target.lon=cam.lon;target.zoom=cam.zoom;target.bearing=cam.bearing;
  following=false;manualBearing=cam.bearing;fittedPreview=true
});
function releasePointer(event){
  delete pointers[event.pointerId];pinch=null;resetDragFromRemaining();
  if(pointerList().length===0)gesturing=false
}
root.addEventListener('pointerup',releasePointer);
root.addEventListener('pointercancel',releasePointer);
document.getElementById('plus').onclick=function(){following=false;manualBearing=cam.bearing;target={lat:cam.lat,lon:cam.lon,zoom:clamp(cam.zoom+1,3,19),bearing:cam.bearing};ensureAnimating()};
document.getElementById('minus').onclick=function(){following=false;manualBearing=cam.bearing;target={lat:cam.lat,lon:cam.lon,zoom:clamp(cam.zoom-1,3,19),bearing:cam.bearing};ensureAnimating()};
document.getElementById('locate').onclick=centerOnPosition;
window.addEventListener('resize',function(){ensureAnimating()});
document.addEventListener('message',function(event){receive(event.data)});
window.addEventListener('message',function(event){receive(event.data)});
post('map_ready')
})();
</script></body></html>`;
}

const styles = StyleSheet.create({
  frame: { ...StyleSheet.absoluteFill, backgroundColor: '#E9EEF5' },
  webview: { flex: 1, backgroundColor: '#E9EEF5' },
  statusPill: { position: 'absolute', top: 96, alignSelf: 'center', backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 99, paddingHorizontal: 13, paddingVertical: 8, elevation: 4 },
  statusText: { color: '#344054', fontSize: 11, fontWeight: '700' },
  attribution: { position: 'absolute', right: 7, bottom: 7, backgroundColor: 'rgba(255,255,255,0.84)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 3 },
  attributionText: { color: '#344054', fontSize: 9 }
});
