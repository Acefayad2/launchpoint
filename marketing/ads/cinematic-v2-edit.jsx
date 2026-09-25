import fs from "node:fs/promises";
export default async ({project})=>{
 const root="/home/user/lpv2";
 const p=await project({dir:root+"/project",size:"1080x1920",fps:30,background:"#090A0C"});
 const logo=await p.add(root+"/logo.png");
 if(process.env.PREVIEW_ONLY!=="1"){
 const video=await p.add(root+"/source.mp4");
 p.cut(video,{from:0,dur:24,at:0,fit:"cover"});
 }
 p.compose(<frame layout="none" width={1080} height={1920}>
  <frame at={0} duration={20.5} x={740} y={130} width={220} height={185} layout="none" clip radius={16}>
    <media file={logo} x={-65} y={-35} width={340} height={340} fit="contain"/>
  </frame>
  <frame at={0} duration={4} layout="none" x={120} y={995} width={830} height={330}
   motion={{enter:{from:{y:18,opacity:0},duration:0.15},exit:{to:{opacity:0},duration:0.12,anchor:"end"}}}>
    <text width={830} height={140} fontFamily="Inter" fontSize={88} fontWeight={800} color="#FFFFFF" shadow={{x:0,y:3,blur:16,color:"#000000"}}>YOU BUILT</text>
    <text y={106} width={830} height={140} fontFamily="Inter" fontSize={88} fontWeight={800} color="#FF8A00" shadow={{x:0,y:3,blur:16,color:"#000000"}}>THE BUSINESS.</text>
  </frame>
  <frame at={4} duration={2.2} layout="none" x={120} y={995} width={830} height={330}
   motion={{enter:{from:{y:18,opacity:0},duration:0.15},exit:{to:{opacity:0},duration:0.12,anchor:"end"}}}>
    <text width={830} height={140} fontFamily="Inter" fontSize={88} fontWeight={800} color="#FFFFFF" shadow={{x:0,y:3,blur:16,color:"#000000"}}>WHY DOES IT</text>
    <text y={106} width={830} height={140} fontFamily="Inter" fontSize={88} fontWeight={800} color="#FF8A00" shadow={{x:0,y:3,blur:16,color:"#000000"}}>STILL RUN YOU?</text>
  </frame>
  <frame at={20.5} duration={3.5} layout="none" width={1080} height={1920} background="#090A0C" motion={{enter:{from:{opacity:0},duration:0.18}}}>
    <frame x={0} y={200} width={1080} height={1080} motion={{enter:{from:{scale:0.96,opacity:0},duration:0.45}}}>
     <media file={logo} width="fill" height="fill" fit="contain"/>
    </frame>
    <text x={120} y={1240} width={840} height={80} fontFamily="Inter" fontSize={31} fontWeight={600} align="center" color="#FFFFFF">WEBSITES · SOFTWARE · APPS · MARKETING</text>
    <rect x={120} y={1340} width={840} height={100} radius={8} fill="#FF8500"/>
    <text x={135} y={1369} width={810} height={60} fontFamily="Inter" fontSize={32} fontWeight={700} align="center" color="#0B0C0F">MESSAGE “LAUNCH” TO GET STARTED</text>
  </frame>
 </frame>,{at:0,dur:24});
 await p.frame(22,root+"/endcard.png");
 if(process.env.PREVIEW_ONLY!=="1"){
  await p.frame(4.8,root+"/cover.png");
  await p.render(root+"/clean.mp4",{bitrate:16000000,shards:2,concurrency:2});
 }
};