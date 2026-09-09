import { PreviewCommandHelp } from "./PreviewCommandHelp.tsx";

export function ProjectPreviewHelp({ isWindows }: { isWindows: boolean }) {
  const ref = (name: string) => isWindows ? `%${name}%` : `$${name}`;
  const combinedHint = isWindows
    ? `start "" /b cmd /c "cd /d back && set SERVER_PORT=%PORT2%&&mvn spring-boot:run" & cd /d front && set VITE_APP_API_URL=%URL2%&&pnpm run dev -- --port %PORT%`
    : "(cd back && SERVER_PORT=$PORT2 mvn spring-boot:run &) ; cd front && VITE_APP_API_URL=$URL2 pnpm run dev -- --port $PORT";
  return <PreviewCommandHelp>
    <section>
      <h3>自动识别启动命令</h3>
      <p>
        自定义脚本留空时，ash 会按各语言的惯例识别启动命令：Maven 的 <code className="mono">spring-boot:run</code>、Gradle 的{" "}
        <code className="mono">bootRun</code>、Django 的 <code className="mono">runserver</code>、FastAPI 的{" "}
        <code className="mono">uvicorn</code>、Flask、<code className="mono">go run</code>、<code className="mono">cargo run</code>、
        <code className="mono">dotnet run</code>、Laravel 的 <code className="mono">artisan</code>、Rails 的{" "}
        <code className="mono">bin/rails</code>、Node 的 dev / start 脚本。
      </p>
      <p><b>只有恰好识别出一个启动项时才会自动使用。</b>如果前后端并列，或 Maven 多个模块各有一个应用，可切到「选择服务」，点击「检测服务」后勾选需要启动的服务，也可以直接编辑脚本。</p>
    </section>
    <section>
      <h3>命令在哪里执行</h3>
      <p>命令在任务工作区（worktree）的根目录执行，使用服务端所在机器的 shell。支持 cd、<code className="mono">&amp;&amp;</code> 和后台任务；ash 会注入 <code className="mono">BROWSER=none</code>。</p>
    </section>
    <section>
      <h3>预览端口与服务地址</h3>
      <p>ash 会为预览分配一组端口。<code className="mono">{ref("PORT")}</code> 用于要在浏览器中查看的服务；辅助服务使用 <code className="mono">{ref("PORT2")}</code>…<code className="mono">{ref("PORT5")}</code>。</p>
      <p>辅助服务还提供对应的地址变量 <code className="mono">{ref("URL2")}</code>…<code className="mono">{ref("URL5")}</code>，例如 <code className="mono">{ref("URL2")}</code> 就是 <code className="mono">http://localhost:{ref("PORT2")}</code>。</p>
    </section>
    <section>
      <h3>同时启动前后端</h3>
      <p>使用「选择服务」时，可勾选多个服务并设置默认打开项。每条脚本使用自己的 <code className="mono">{ref("PORT")}</code>；已选服务按列表顺序对应 <code className="mono">{ref("URL1")}</code>、<code className="mono">{ref("URL2")}</code> 等内部地址。</p>
      <p>自定义脚本中可将辅助服务放到后台，需要预览的服务放在最后。例如：</p>
      <pre><code className="mono">{combinedHint}</code></pre>
      <p>前端连接后端的变量名取决于项目配置（Vite 项目通常使用 <code className="mono">VITE_*_URL</code>）。请按项目实际使用的名称填写，ash 只负责提供服务地址。</p>
    </section>
    <section>
      <h3>把端口传给运行时</h3>
      <p>
        不同运行时的端口配置方式不同。ash 会以常见的环境变量名称传入同一个端口：
        <code className="mono">PORT</code>（Node / Go / Rust）、<code className="mono">SERVER_PORT</code>（Spring Boot）、
        <code className="mono">ASPNETCORE_URLS</code>（ASP.NET Core）、<code className="mono">QUARKUS_HTTP_PORT</code>、
        <code className="mono">FLASK_RUN_PORT</code>。
      </p>
      <p>Vite、Angular、Django、Laravel、Rails 等需要通过命令行参数指定端口，请把 <code className="mono">{ref("PORT")}</code> 写进命令。自动识别的命令已包含这些参数，手动填写时也需要保留。
    {isWindows && " 上面这些写法是按 Windows 的 cmd 给的（ash 就跑在 Windows 上），POSIX 那套 $PORT 在这儿不展开。"}
      </p>
    </section>
    <section>
      <h3>启动失败时排查</h3>
      <p>打开任务底部的「预览日志」，可以查看实际执行的命令、注入的端口和命令输出。启动失败的日志也会保留。</p>
    </section>
  </PreviewCommandHelp>;
}
