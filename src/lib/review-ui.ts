function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Lock before the HTTP round-trip, including keyboard interaction and Cancel. */
export function reviewClientScript(runId: string): string {
  return `
const reviewRunId=${JSON.stringify(runId).replace(/</g, "\\u003c")};
const reviewForm=document.querySelector('form');
const toolBoxes=Array.from(document.querySelectorAll('input[name="toolIds"][type="checkbox"]'));
const continueButton=document.querySelector('.approve');
const selectionStatus=document.getElementById('selection-status');
let busy=false;
let submitted=false;
const busyLayer=document.createElement('section');
busyLayer.id='review-busy';busyLayer.hidden=true;busyLayer.setAttribute('role','status');busyLayer.setAttribute('aria-live','polite');busyLayer.tabIndex=-1;
busyLayer.style.cssText='position:fixed;inset:0;z-index:100;background:#f4f7fb;display:none;place-content:center;padding:2rem;text-align:center;font:18px system-ui';
const busyHeading=document.createElement('h1');busyHeading.textContent='Please wait';
const busyMessage=document.createElement('p');
const boundary=document.createElement('p');boundary.textContent='Controls are locked while this request completes. Approval requires confirmation of the exact reviewed draft.';
busyLayer.append(busyHeading,busyMessage,boundary);document.body.append(busyLayer);
function lockReview(message){
  busy=true;document.body.setAttribute('aria-busy','true');
  for(const element of document.querySelectorAll('form,a,details'))element.inert=true;
  for(const element of document.querySelectorAll('input,textarea,select,button'))element.disabled=true;
  busyLayer.hidden=false;busyLayer.style.display='grid';busyMessage.textContent=message;busyLayer.focus();
}
function selectionChanged(){
  if(!continueButton||!selectionStatus)return;
  const count=toolBoxes.filter(box=>box.checked).length;
  const subset=count>0&&count<toolBoxes.length;
  continueButton.textContent=subset?'Prepare selected-tool draft':'✓ Approve reviewed draft';
  continueButton.disabled=count===0;
  selectionStatus.textContent=subset?'Core will remove rejected registrations and regenerate corresponding tasks. You will review a new patch before approval.':'';
}
toolBoxes.forEach(box=>box.addEventListener('change',selectionChanged));
if(toolBoxes.length)selectionChanged();
const pollTimer=setInterval(async()=>{
  try{
    const response=await fetch('/review-status',{cache:'no-store'});if(!response.ok)return;
    const status=await response.json();
    if(status.state==='revising'||status.state==='busy')lockReview(status.phase||'Updating the reviewed draft…');
    else if(status.runId!==reviewRunId||(busy&&!submitted))location.replace('/');
  }catch{}
},1000);
if(reviewForm)reviewForm.addEventListener('submit',async event=>{
  event.preventDefault();if(submitted||busy)return;submitted=true;
  const body=new URLSearchParams(new FormData(reviewForm));
  const endpoint=event.submitter&&event.submitter.classList.contains('reject')?'/reject':'/approve';
  lockReview(endpoint==='/reject'?'Recording rejection…':toolBoxes.some(box=>!box.checked)?'Removing rejected tools and preparing the revised draft…':'Preparing approval…');
  try{
    const response=await fetch(endpoint,{method:'POST',body});
    const html=await response.text();clearInterval(pollTimer);
    document.open();document.write(html);document.close();
  }catch{
    busyMessage.textContent='Connection interrupted. This does not cancel a revision. Reload the review page to check its status.';
    const link=document.createElement('a');link.href='/';link.textContent='Reload review status';busyLayer.append(link);
  }
});`;
}

/** No writable controls, including on refresh or another browser tab. */
export function reviewBusyPage(project: string, phase: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project)} — updating review</title><style>body{font:18px system-ui;background:#f4f7fb;text-align:center;padding:15vh 2rem}</style></head><body aria-busy="true"><main role="status" aria-live="polite"><h1>Updating selected tools</h1><p id="phase">${escape(phase)}</p><p>No approval has been created. The original application is unchanged.</p><p>Tool selection and approval are locked. The revised draft will reopen automatically for fresh review.</p></main><script>
setInterval(async()=>{try{const response=await fetch('/review-status',{cache:'no-store'});if(!response.ok)return;const status=await response.json();if(status.state==='revising'||status.state==='busy')document.getElementById('phase').textContent=status.phase||'Updating the draft…';else location.replace('/');}catch{}},1000);
</script></body></html>`;
}
