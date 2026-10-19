import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "../../web/scripts/chrome-path.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const esbuild = require("esbuild");
const mocks = {
  "react-native": `import React from "react";
    export const View = ({children}) => <div>{children}</div>;
    export const Text = ({children}) => <span>{children}</span>;
    export const ScrollView = View;
    export const KeyboardAvoidingView = View;
    export const Pressable = ({children,onPress,disabled}) => <button onClick={onPress} disabled={disabled}>{children}</button>;
    export const Keyboard = {dismiss(){}};
    export const Platform = {OS:"web"};
    export const Alert = {alert(...args){window.mock.alerts.push(args)}};
    export const AppState = {addEventListener(_event, listener){
      const handler = (event) => listener(event.detail);
      window.addEventListener("app-state", handler);
      return {remove(){window.removeEventListener("app-state", handler)}};
    }};`,
  "expo-router": `import {useEffect, useState} from "react";
    export const useRouter = () => ({replace(path){window.mock.destination = path}});
    export function useFocusEffect(effect){
      const [focused, setFocused] = useState(true);
      useEffect(() => {
        const handler = (event) => setFocused(event.detail);
        window.addEventListener("route-focus", handler);
        return () => window.removeEventListener("route-focus", handler);
      }, []);
      useEffect(() => {
        window.mock.focused = focused;
        return focused ? effect() : undefined;
      }, [focused, effect]);
    }`,
  "react-native-safe-area-context": `export const useSafeAreaInsets = () => ({bottom:0});`,
  "@/lib/theme": `export const useTheme = () => ({});`,
  "@/lib/util": `export const groupLabel = (group) => group.name;`,
  "@/lib/store": `export const useStore = (select) => select(window.mock.store);`,
  "@/lib/api": `export const api = {
    agents: async () => [], llmProviders: async () => [],
    detectAgents: async () => [{type:"claude",available:true,resident:true}],
    projectBranches: async (projectId) => {
      const response = {current:window.mock.current[projectId], branches:[...window.mock.branches[projectId]]};
      window.mock.requests.push({projectId, ...response});
      if (window.mock.deferNext) {
        window.mock.deferNext = false;
        return new Promise((resolve, reject) => window.mock.pending.push({resolve:() => resolve(response), reject}));
      }
      return response;
    },
    createTask: async (input) => {
      const task = {...input, id:"created", resolvedBase:input.worktreeBase || window.mock.current[input.projectId]};
      window.mock.created.push(task); return task;
    },
    runTask: async () => {},
  };`,
  "@/components/ui": `import React from "react";
    export const Pill = ({label,active,onPress}) => <button aria-pressed={active} onClick={onPress}>{label}</button>;
    export const Button = ({label,onPress,disabled}) => <button disabled={disabled} onClick={onPress}>{label}</button>;
    export const Input = ({value,onChangeText,placeholder}) => <textarea placeholder={placeholder} value={value} onChange={(event) => onChangeText(event.target.value)}/>;`,
  "@/components/ScheduleFields": `export const ScheduleFields = () => null;`,
  "@/components/TeamTaskOptions": `export const TeamTaskOptions = () => null;`,
  "@/components/ExecutionConfig": `export const ExecutionConfig = () => null;`,
};
const bundle = await esbuild.build({
  stdin: {resolveDir:repo, loader:"tsx", contents:`
    import React from "react";
    import {createRoot} from "react-dom/client";
    import NewTask from "${repo}mobile/src/app/new.tsx";
    const projects = ["A", "B"].map((id) => ({id,name:"项目"+id,useWorktreeDefault:true,health:{isRepo:true}}));
    window.mock = {
      store:{projects,projectId:"A",groups:[],upsertTask(){},upsertProject(){},upsertGroup(){}},
      current:{A:"main",B:"other"},branches:{A:["main","version-upgrade"],B:["other"]},
      alerts:[],created:[],requests:[],pending:[],deferNext:false,
    };
    createRoot(document.getElementById("app")).render(<NewTask/>);
  `},
  bundle:true,write:false,format:"iife",jsx:"automatic",
  plugins:[{name:"native-shell-only", setup(build){
    build.onResolve({filter:/.*/}, (args) => {
      const key = args.path === "./api" && args.importer.endsWith("useTaskBranches.ts") ? "@/lib/api" : args.path;
      if (mocks[key]) return {path:key,namespace:"shell"};
      if (key === "@/lib/useTaskBranches") return {path:repo+"mobile/src/lib/useTaskBranches.ts"};
      if (key === "@/lib/constants") return {path:repo+"mobile/src/lib/constants.ts"};
      if (/^react(\/.*)?$/.test(key)) return {path:require.resolve(key)};
    });
    build.onLoad({filter:/.*/,namespace:"shell"}, (args) => ({contents:mocks[args.path],loader:"jsx",resolveDir:repo}));
  }}],
});
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<meta charset="utf-8"><div id="app"></div><script>${bundle.outputFiles[0].text}</script>`);
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({...await chromeLaunchOptions(),headless:true});
  const page = await browser.newPage({viewport:{width:440,height:1100}});
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const automatic = page.getByRole("button", {name:"跟随项目分支（创建时确定）",exact:true});
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", {name:"main",exact:true}).waitFor();
    assert.equal(await automatic.getAttribute("aria-pressed"), "true");
  };
  const emit = (name, detail) => page.evaluate(({name,detail}) => window.dispatchEvent(new CustomEvent(name,{detail})), {name,detail});
  const create = async () => {
    await page.getByPlaceholder("要这个 agent 做什么…").fill("分支跟随回归");
    await page.getByRole("button", {name:"仅创建",exact:true}).click();
    await page.getByRole("button", {name:"创建任务",exact:true}).click();
    await page.waitForFunction(() => window.mock.created.length === 1);
    return page.evaluate(() => window.mock.created[0]);
  };
  await open();
  await page.evaluate(() => {window.mock.current.A = "version-upgrade"});
  const followed = await create();
  assert.equal(followed.worktreeBase, null);
  assert.equal(followed.resolvedBase, "version-upgrade");
  console.log("✓ 手机新建任务默认发送空基准，面板外切分支后仍按创建时分支起跑");

  await open();
  await page.getByRole("button", {name:"version-upgrade",exact:true}).click();
  await emit("route-focus", false);
  await page.waitForFunction(() => window.mock.focused === false);
  await page.evaluate(() => {window.mock.current.A = "release"; window.mock.branches.A.push("release")});
  await emit("route-focus", true);
  await page.getByRole("button", {name:"release",exact:true}).waitFor();
  await page.evaluate(() => {window.mock.branches.A.push("foreground")});
  await emit("app-state", "active");
  await page.getByRole("button", {name:"foreground",exact:true}).waitFor();
  assert.equal((await create()).worktreeBase, "version-upgrade");
  console.log("✓ 返回页面和回到前台都会刷新候选，手选基准不被刷新覆盖");

  await open();
  await page.getByRole("button", {name:"version-upgrade",exact:true}).click();
  await automatic.click();
  assert.equal((await create()).worktreeBase, null);
  console.log("✓ 手机可从手选恢复自动跟随");

  await open();
  await page.evaluate(() => {window.mock.deferNext = true; window.mock.branches.A = ["stale"]});
  await emit("app-state", "active");
  await page.waitForFunction(() => window.mock.pending.length === 1);
  await page.evaluate(() => {window.mock.branches.A = ["latest"]});
  await emit("app-state", "active");
  await page.getByRole("button", {name:"latest",exact:true}).waitFor();
  await page.evaluate(() => window.mock.pending[0].resolve());
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole("button", {name:"stale",exact:true}).count(), 0);
  await page.getByRole("button", {name:"latest",exact:true}).click();
  await page.evaluate(() => {window.mock.deferNext = true});
  await emit("app-state", "active");
  await page.waitForFunction(() => window.mock.pending.length === 2);
  await page.getByRole("button", {name:"项目B",exact:true}).click();
  await page.getByRole("button", {name:"other",exact:true}).waitFor();
  await page.evaluate(() => window.mock.pending[1].resolve());
  assert.equal(await automatic.getAttribute("aria-pressed"), "true");
  if (process.env.ASH_BROWSER_SCREENSHOT) await page.screenshot({path:process.env.ASH_BROWSER_SCREENSHOT,fullPage:true});
  const changed = await create();
  assert.equal(changed.projectId, "B");
  assert.equal(changed.worktreeBase, null);
  assert.equal(changed.resolvedBase, "other");
  assert.equal(await page.getByRole("button", {name:"latest",exact:true}).count(), 0);
  console.log("✓ 迟到候选被丢弃，换项目清掉手选和旧列表");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
