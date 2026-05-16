// @ts-expect-error - .marko files are compiled by the @marko/vite plugin
import template from "./App.marko";

template.renderSync({}).appendTo(document.getElementById("app")!);
