/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { getMicroAppStateActions } from './globalState';
import { FrameworkConfiguration, FrameworkLifeCycles, HTMLContentRender, LifeCycleFn, LoadableApp } from './interfaces';
import { createSandbox, css } from './sandbox';
import {
  Deferred,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new Error(msg);
    }

    throw new Error('[qiankun] element not existed!');
  }
}

function execHooksChain<T extends object>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends object>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

// @ts-ignore
const supportShadowDOM = document.head.attachShadow || document.head.createShadowRoot;
function createElement(appContent: string, strictStyleIsolation: boolean): HTMLElement {
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // appContent always wrapped with a singular div
  const appElement = containerElement.firstChild as HTMLElement;
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      if (appElement.attachShadow) {
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  return appElement;
}

/** generate app wrapper dom getter */
function getAppWrapperGetter(
  appName: string,
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  enableScopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new Error('[qiankun]: strictStyleIsolation can not be used with legacy render!');
      if (enableScopedCSS) throw new Error('[qiankun]: experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(
        appWrapper,
        `[qiankun] Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`,
      );
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(
      element,
      `[qiankun] Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`,
    );

    if (enableScopedCSS) {
      const attr = element!.getAttribute(css.QiankunCSSRewriteAttr);
      if (!attr) {
        element!.setAttribute(css.QiankunCSSRewriteAttr, appName);
      }
    }

    if (strictStyleIsolation) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; remountContainer?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * @param appName
 * @param appContent
 * @param container
 * @param legacyRender
 */
function getRender(
  appName: string,
  appContent: string,
  container?: string | HTMLElement,
  legacyRender?: HTMLContentRender,
) {
  const render: ElementRender = ({ element, loading, remountContainer }, phase) => {
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[qiankun] Custom rendering function is deprecated, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(remountContainer || container!);

    // The container might have be removed after micro app unmounted.
    // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `[qiankun] Target container with ${container} not existed while ${appName} ${phase}!`;

          case 'mounted':
            return `[qiankun] Target container with ${container} not existed after ${appName} ${phase}!`;

          default:
            return `[qiankun] Target container with ${container} not existed while ${appName} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    if (containerElement && !containerElement.contains(element)) {
      // clear the container
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // append the element to container if it exist
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

function getLifecyclesFromExports(scriptExports: LifeCycles<any>, appName: string, global: WindowProxy) {
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new Error(`[qiankun] You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

/**
 * 在符合路由规则后，加载App的相关资源，包括html模板，html中对应的 js、css 资源
 * @param app
 * @param configuration
 * @param lifeCycles
 */
export async function loadApp<T extends object>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  const { entry, name: appName } = app;
  const appInstanceId = `${appName}_${+new Date()}_${Math.floor(Math.random() * 1000)}`;

  const markName = `[qiankun] App ${appInstanceId} Loading`;
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  const { singular = false, sandbox = true, excludeAssetFilter, ...importEntryOpts } = configuration;

  /**
   * 获取入口html文本，抽取出其 js 和 css 资源
   * 详见：https://github.com/kuitos/import-html-entry
   */
  const { template, execScripts, assetPublicPath } = await importEntry(entry, importEntryOpts);

  // as single-spa load and bootstrap new app parallel with other apps unmounting
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  // we need wait to load the app until all apps are finishing unmount in singular mode
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  /**
   * 准备一个div容器，放置App
   * 1. 生成模板
   * 2. 判断是否需要样式隔离
   *  2.1 样式隔离采用 shadow-dom 的方案（如果浏览器不支持该特性，则忽略样式隔离，采用约定方案）
   * 3. 生成对应容器元素
   * 4. 如果使用了 scoped-css (类似vue)，改造对应<style>内容
   */
  const appContent = getDefaultTplWrapper(appInstanceId, appName)(template);
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
  let appWrapperElement: HTMLElement | null = createElement(appContent, strictStyleIsolation);
  const enableScopedCSS = isEnableScopedCSS(sandbox);
  if (appWrapperElement && enableScopedCSS) {
    const styleNodes = appWrapperElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appWrapperElement!, stylesheetElement, appName);
    });
  }

  const container = 'container' in app ? app.container : undefined;
  const legacyRender = 'render' in app ? app.render : undefined;

  /**
   * 主程序render
   * 本质是将元素通过 appendChild 挂载到指定的container上
   */
  const render = getRender(appName, appContent, container, legacyRender);

  // 第一次加载设置应用可见区域 dom 结构
  // 确保每次应用加载前容器 dom 结构已经设置完毕
  render({ element: appWrapperElement, loading: true }, 'loading');

  const appWrapperGetter = getAppWrapperGetter(
    appName,
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    enableScopedCSS,
    () => appWrapperElement,
  );

  /**
   * 为该App新建沙箱，获得代理的window
   */
  let global = window;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  if (sandbox) {
    const sandboxInstance = createSandbox(
      appName,
      appWrapperGetter,
      enableScopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
    );
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxInstance.proxy as typeof window;
    mountSandbox = sandboxInstance.mount;
    unmountSandbox = sandboxInstance.unmount;
  }

  const { beforeUnmount = [], afterUnmount = [], afterMount = [], beforeMount = [], beforeLoad = [] } = mergeWith(
    {},
    getAddOns(global, assetPublicPath),
    lifeCycles,
    (v1, v2) => concat(v1 ?? [], v2 ?? []),
  );

  /**
   * 以下涉及到各个生命周期钩子
   * 1. 执行beforeLoad
   * 2. 使用 eval 函数执行 entry 的 js 文本，获得导出的模块(也是选用webpack umd打包方式的原因)
   * 3. 提供 onGlobalStateChange、setGlobalState、offGlobalStateChange 三个全局通信方法，
   *    以便植入子应用 mount 钩子的 props 中
   * 4. 将入口提供的 bootstrap、mount、unmount 钩子打包给 single-spa 使用
   */
  await execHooksChain(toArray(beforeLoad), app, global);

  // get the lifecycle hooks from module exports
  const scriptExports: any = await execScripts(global, !useLooseSandbox);
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(scriptExports, appName, global);

  const {
    onGlobalStateChange,
    setGlobalState,
    offGlobalStateChange,
  }: Record<string, Function> = getMicroAppStateActions(appInstanceId);

  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer) => {
    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performance.getEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (!marks.length) {
              performanceMark(markName);
            }
          }
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          // element would be destroyed after unmounted, we need to recreate it if it not exist
          appWrapperElement = appWrapperElement || createElement(appContent, strictStyleIsolation);
          render({ element: appWrapperElement, loading: true, remountContainer }, 'mounting');
        },
        mountSandbox,
        // exec the chain after rendering to keep the behavior with beforeLoad
        async () => execHooksChain(toArray(beforeMount), app, global),
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
        // finish loading after app mounted
        async () => render({ element: appWrapperElement, loading: false, remountContainer }, 'mounted'),
        async () => execHooksChain(toArray(afterMount), app, global),
        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        unmountSandbox,
        async () => execHooksChain(toArray(afterUnmount), app, global),
        async () => {
          render({ element: null, loading: false, remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
