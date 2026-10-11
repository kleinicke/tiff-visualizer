const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function perfCount(dir) {
 let count = 0;
 if (!fs.existsSync(dir)) return count;
 for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
  const file=path.join(dir,e.name);
  if(e.isDirectory()) count+=perfCount(file);
  else if(e.name.endsWith('.log')) count+=(fs.readFileSync(file,'utf8').match(/\[Perf\]/g)||[]).length;
 }
 return count;
}
exports.run = async () => {
 const cases=JSON.parse(process.env.DEPTH_CASES);
 const captures=[];
 const stub=vscode.commands.registerCommand('plyViewer.convertNpyToPointCloud',async uri=>{
  const bytes=Buffer.from(await vscode.workspace.fs.readFile(uri));
  const offset=10+bytes.readUInt16LE(8);
  captures.push({uri, header:bytes.subarray(10,offset).toString(),values:Array.from({length:(bytes.length-offset)/8},(_,i)=>bytes.readDoubleLE(offset+i*8))});
 });
 try {
  for(const item of cases) {
   const before=perfCount(process.env.DEPTH_LOGS);
   await vscode.commands.executeCommand('vscode.openWith',vscode.Uri.file(item.file),'tiffVisualizer.previewEditor',{preview:false});
   const deadline=Date.now()+45000;
   while(perfCount(process.env.DEPTH_LOGS)<=before) {
    if(Date.now()>deadline) throw new Error('Image did not finish loading: '+item.file);
    await new Promise(r=>setTimeout(r,100));
   }
   const n=captures.length;
   await vscode.commands.executeCommand('tiffVisualizer.openAsPointCloud');
   assert.equal(captures.length,n+1,'Command must reach the PLY handoff');
   const result=captures.at(-1);
   assert.match(result.header,/'shape': \(5, 6\)/);
   assert.deepEqual(result.values,item.values);
   assert.notEqual(result.uri.fsPath,item.file);
   assert.equal(path.extname(result.uri.fsPath),'.npy');
   console.log('PASS selected depth handoff:',path.basename(item.file));
   await vscode.workspace.fs.delete(result.uri);
   await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
 } finally {stub.dispose();}
};
