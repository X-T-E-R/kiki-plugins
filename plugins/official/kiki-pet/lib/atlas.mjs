const names = ['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'];
const counts = [6,8,8,4,5,8,6,6,6];
const durations = [[280,110,110,140,140,320],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[140,140,140,140,140,140,140,240],[150,150,150,150,150,260],[120,120,120,120,120,220],[150,150,150,150,150,280]];
const integer = (v,min,max,label) => { if(!Number.isInteger(v)||v<min||v>max)throw new Error(`Invalid ${label}`);return v; };
export function normalizeAtlas(manifest, dimensions) {
 const {width,height}=dimensions;
 integer(width,1,4096,'image width');integer(height,1,4096,'image height');
 if(width*height>8_000_000)throw new Error('Image exceeds 8 megapixels');
 let atlas, animations;
 if(manifest.atlas !== undefined){
  const a=manifest.atlas;
  const columns=integer(a.columns,1,64,'atlas columns'), rows=integer(a.rows,1,64,'atlas rows');
  if(width%columns||height%rows)throw new Error('Atlas dimensions must divide evenly into cells');
  const cellWidth=width/columns,cellHeight=height/rows;
  if((a.width!==undefined&&a.width!==width)||(a.height!==undefined&&a.height!==height)||(a.cellWidth!==undefined&&a.cellWidth!==cellWidth)||(a.cellHeight!==undefined&&a.cellHeight!==cellHeight))throw new Error('Atlas metadata disagrees with decoded image');
  atlas={width,height,columns,rows,cellWidth,cellHeight};
  if(!manifest.animations||typeof manifest.animations!=='object'||Array.isArray(manifest.animations))throw new Error('Custom atlas requires explicit animations');
  animations={};
  for(const [name,animation] of Object.entries(manifest.animations)){
   if(!/^[a-z][a-z0-9-]{0,31}$/.test(name)||Object.keys(animations).length>=32)throw new Error('Invalid animation name/count');
   const row=integer(animation.row,0,rows-1,'animation row'),frameCount=integer(animation.frameCount,1,columns,'frame count');
   const frameDurationsMs=animation.frameDurationsMs??Array(frameCount).fill(animation.frameDurationMs??150);
   if(!Array.isArray(frameDurationsMs)||frameDurationsMs.length!==frameCount)throw new Error('Frame timing count disagrees with animation');
   frameDurationsMs.forEach(v=>integer(v,16,10000,'frame duration'));
   animations[name]={row,frameCount,frameDurationsMs};
  }
  if(!animations.idle)throw new Error('Custom atlas must define idle');
 }else{
  const version=manifest.spriteVersionNumber??(height===2288&&width===1536?2:1);
  if(![1,2].includes(version))throw new Error('Unsupported Codex spriteVersionNumber');
  const rows=version===2?11:9;
  if(width!==1536||height!==rows*208)throw new Error('Not a Codex v1/v2 atlas; custom dimensions require atlas and animations metadata');
  atlas={width,height,columns:8,rows,cellWidth:192,cellHeight:208};
  animations=Object.fromEntries(names.map((name,row)=>[name,{row,frameCount:counts[row],frameDurationsMs:durations[row]}]));
  if(version===2)atlas.gaze={neutral:{row:0,column:6},frames:Array.from({length:16},(_,index)=>({row:index<8?9:10,column:index%8})),deadZonePx:24,resetAfterMs:1200};
 }
 return {atlas,animations};
}
export function sanitizeId(value) { const id=String(value??'pet').normalize('NFKD').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);return id||'pet'; }
export function shortText(value,limit=160) { return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit):''; }
