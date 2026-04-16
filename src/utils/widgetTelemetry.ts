const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isWidgetTelemetryEnabled(
  raw = process.env.LETTER_IRL_WIDGET_TELEMETRY_ENABLED
): boolean {
  return raw ? TRUE_VALUES.has(raw.trim().toLowerCase()) : false;
}

export function getWidgetTelemetryEndpoint(apiUrl: string): string {
  const explicit = process.env.LETTER_IRL_WIDGET_TELEMETRY_ENDPOINT;
  if (explicit) {
    return explicit;
  }

  return `${apiUrl.replace(/\/$/, "")}/api/widget-diagnostic`;
}

export function injectWidgetTelemetry(html: string, widgetName: string, apiUrl: string): string {
  if (!isWidgetTelemetryEnabled()) {
    return html;
  }

  const config = JSON.stringify({
    enabled: true,
    endpoint: getWidgetTelemetryEndpoint(apiUrl),
    widgetName
  });

  const snippet = `<script>window.__LETTER_IRL_WIDGET_TELEMETRY__=${config};(function(){var c=window.__LETTER_IRL_WIDGET_TELEMETRY__;if(!c||!c.enabled||!c.endpoint)return;function safeOpenAi(){var o=window.openai||{};return{hasOpenAi:!!window.openai,theme:o.theme||null,displayMode:o.displayMode||null,maxHeight:o.maxHeight||null,hasToolOutput:!!o.toolOutput,hasToolResponseMetadata:!!o.toolResponseMetadata};}function send(event,details){try{var body=JSON.stringify(Object.assign({event:event,widgetName:c.widgetName,timestamp:new Date().toISOString(),userAgent:navigator.userAgent,visibilityState:document.visibilityState,viewport:{width:window.innerWidth,height:window.innerHeight,devicePixelRatio:window.devicePixelRatio||1},openai:safeOpenAi()},details||{}));fetch(c.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:body,keepalive:true}).catch(function(){});}catch(e){}}window.letterIrlWidgetTelemetry={send:send,waiting:function(details){send("widget.waiting_for_tool_output",details);},rendered:function(details){send("widget.rendered",details);}};send("widget.script_loaded");window.addEventListener("openai:set_globals",function(){send("widget.openai_set_globals");});document.addEventListener("visibilitychange",function(){send("widget.visibility_change");});window.addEventListener("pageshow",function(e){send("widget.pageshow",{persisted:!!e.persisted});});})();</script>`;

  return html.includes("</head>")
    ? html.replace("</head>", `${snippet}\n  </head>`)
    : `${snippet}\n${html}`;
}

export function logWidgetTelemetryEvent(
  event: string,
  details: Record<string, unknown>
): void {
  if (!isWidgetTelemetryEnabled()) {
    return;
  }

  console.log(
    JSON.stringify({
      level: "debug",
      timestamp: new Date().toISOString(),
      event,
      ...details
    })
  );
}
