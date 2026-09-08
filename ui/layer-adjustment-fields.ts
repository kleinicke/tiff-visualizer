import type { LayerAdjustment } from '../media/modules/layer-compositor';
export interface AdjustmentField {
  key: string; label: string; min: number; max: number; step: number;
  value: number; defaultValue: number; decimals: number; suffix: string;
  change: (value: number) => void;
}
/** Describe numeric controls without giving the UI ownership of layer history. */
export function adjustmentFields(adjustment: LayerAdjustment, selection: string, commit: (adjustment: LayerAdjustment) => void): AdjustmentField[] {
  const data = adjustment as unknown as Record<string, any>;
  let group = '', defaults: Record<string, number> = {};
  type Definition = [string, string, number, number, number, number, number?, string?];
  let definitions: Definition[] = [];
  if (adjustment.type === 'levels') {
    group = selection;
    definitions = [['shadowInput','Black in',0,255,1,0],['midtoneInput','Gamma',0.1,9.99,0.01,1,2],['highlightInput','White in',0,255,1,255],['shadowOutput','Black out',0,255,1,0],['highlightOutput','White out',0,255,1,255]];
  } else if (adjustment.type === 'hue/saturation') {
    const colorize = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
    group = colorize ? 'colorize' : selection;
    definitions = [['hue','Hue (°)',-180,180,1,0,0,'°'],['saturation','Saturation',colorize ? 0 : -100,100,1,colorize ? 100 : 0],['lightness','Lightness',-100,100,1,0]];
  } else if (adjustment.type === 'brightness/contrast') {
    definitions = [['brightness','Brightness',-100,100,1,0],['contrast','Contrast',-100,100,1,0]];
  } else if (adjustment.type === 'exposure') {
    definitions = [['exposure','Exposure',-5,5,0.1,0,1,' EV'],['offset','Offset',-0.5,0.5,0.01,0,2],['gamma','Gamma',0.1,5,0.01,1,2]];
  } else if (adjustment.type === 'channel mixer') {
    group = adjustment.monochrome ? 'gray' : selection;
    defaults = group === 'red' ? {red:100,green:0,blue:0,constant:0} : group === 'green' ? {red:0,green:100,blue:0,constant:0} : group === 'blue' ? {red:0,green:0,blue:100,constant:0} : {red:40,green:40,blue:20,constant:0};
    definitions = Object.entries(defaults).map(([key,value]) => [key,key[0].toUpperCase()+key.slice(1),-200,200,1,value,0,'%']);
  } else if (adjustment.type === 'color balance') {
    group = selection;
    definitions = [['cyanRed','Cyan ↔ Red',-100,100,1,0],['magentaGreen','Magenta ↔ Green',-100,100,1,0],['yellowBlue','Yellow ↔ Blue',-100,100,1,0]];
  } else if (adjustment.type === 'black & white') {
    defaults = {reds:40,yellows:60,greens:40,cyans:60,blues:20,magentas:80};
    definitions = Object.entries(defaults).map(([key,value]) => [key,key[0].toUpperCase()+key.slice(1),-200,300,1,value,0,'%']);
  } else if (adjustment.type === 'threshold') definitions = [['level','Threshold',0,255,1,128]];
  else if (adjustment.type === 'posterize') definitions = [['levels','Levels',2,32,1,4]];
  const values = group ? (!Array.isArray(data[group]) && data[group] || {}) : data;
  return definitions.map(([key,label,min,max,step,defaultValue,decimals = 0,suffix = '']) => ({ key,label,min,max,step,defaultValue,decimals,suffix,value:values[key] ?? defaultValue,
    change: value => commit((group ? { ...data, [group]: { ...defaults, ...values, [key]: value } } : { ...data, [key]: value }) as LayerAdjustment),
  }));
}
