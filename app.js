const DB_NAME="csm-db",STORE="imgs";
const memory=new Map();

function openDB(){
 return new Promise(res=>{
  const r=indexedDB.open(DB_NAME,1);
  r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
  r.onsuccess=()=>res(r.result);
 });
}

async function saveDB(k,b){
 const db=await openDB();
 db.transaction(STORE,"readwrite").objectStore(STORE).put(b,k);
}

async function getDB(k){
 const db=await openDB();
 return new Promise(res=>{
  const r=db.transaction(STORE).objectStore(STORE).get(k);
  r.onsuccess=()=>res(r.result);
  r.onerror=()=>res(null);
 });
}

async function loadImg(key,file){
 if(memory.has(key))return memory.get(key);

 const db=await getDB(key);
 if(db){
  const u=URL.createObjectURL(db);
  memory.set(key,u);return u;
 }

 await saveDB(key,file);
 const u=URL.createObjectURL(file);
 memory.set(key,u);return u;
}

const up=document.getElementById("upload");
const gal=document.getElementById("gallery");
const lb=document.getElementById("lightbox");
const img=document.getElementById("lightbox-img");

up.onchange=async e=>{
 for(let f of e.target.files){
  const id=f.name+Date.now();
  const url=await loadImg(id,f);

  const d=document.createElement("div");
  d.className="card";

  const im=document.createElement("img");
  im.src=url;

  im.onclick=()=>openLB(url);

  d.appendChild(im);
  gal.appendChild(d);
 }
};

function openLB(url){
 lb.classList.remove("hidden");
 img.style.opacity="0";
 img.src=url;

 requestAnimationFrame(()=>{
  img.classList.add("show");
 });

 scale=1;
 img.style.transform="scale(1)";
}

lb.onclick=()=>{
 lb.classList.add("hidden");
 img.classList.remove("show");
};

let scale=1;

img.addEventListener("wheel",e=>{
 e.preventDefault();
 scale+=e.deltaY*-0.001;
 scale=Math.min(Math.max(.5,scale),3);
 img.style.transform=`scale(${scale})`;
});

let startDist=0;

img.addEventListener("touchmove",e=>{
 if(e.touches.length===2){
  const dx=e.touches[0].clientX-e.touches[1].clientX;
  const dy=e.touches[0].clientY-e.touches[1].clientY;
  const dist=Math.sqrt(dx*dx+dy*dy);

  if(!startDist)startDist=dist;

  scale=dist/startDist;
  img.style.transform=`scale(${scale})`;
 }
});
