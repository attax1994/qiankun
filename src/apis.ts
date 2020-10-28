import { noop } from 'lodash'
import { mountRootParcel, ParcelConfigObject, registerApplication, start as startSingleSpa } from 'single-spa'
import { FrameworkConfiguration, FrameworkLifeCycles, LoadableApp, MicroApp, RegistrableApp } from './interfaces'
import { loadApp, ParcelConfigObjectGetter } from './loader'
import { doPrefetchStrategy } from './prefetch'
import { Deferred, getContainer, getXPathForElement, toArray } from './utils'

let microApps: RegistrableApp[] = []

// eslint-disable-next-line import/no-mutable-exports
export let frameworkConfiguration: FrameworkConfiguration = {}
const frameworkStartedDefer = new Deferred<void>()

/**
 * 注册微应用，基于路由机制自动加载
 * @param apps
 * @param lifeCycles
 */
export function registerMicroApps<T extends object = {}>(
  apps: Array<RegistrableApp<T>>,
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  /**
   * micro-app重复注册校验，只加入新添加的
   */
  const unregisteredApps = apps
    .filter((app) =>
      !microApps.some(({name}) =>
        name === app.name,
      ),
    )
  microApps = [...microApps, ...unregisteredApps]

  /**
   * 注册新的app
   */
  unregisteredApps.forEach((app) => {
    const {name, activeRule, loader = noop, props, ...appConfig} = app

    // 标准的Single-SPA注册，详见：https://single-spa.js.org/docs/api#registerapplication
    registerApplication({
      name,
      // 执行后获取应用对象
      app        : async () => {
        loader(true)
        await frameworkStartedDefer.promise

        const {mount, ...otherMicroAppConfigs} = (
          // 加载App
          await loadApp({name, props, ...appConfig}, frameworkConfiguration, lifeCycles)
        )()

        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        }
      },
      // 路径匹配，匹配每个以该路径开头的URL。路径前缀也接受动态值(以':'开头)
      activeWhen : activeRule,
      // 在生命周期钩子函数执行时会被作为参数传入
      customProps: props,
    })
  })
}

const appConfigPormiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>()

/**
 * 手动加载微应用(与路由机制分离)
 * @param app
 * @param configuration
 * @param lifeCycles
 */
export function loadMicroApp<T extends object = {}>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration,
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const {props, name} = app

  const getContainerXpath = (container: string | HTMLElement): string | void => {
    const containerElement = getContainer(container)
    if (containerElement) {
      return getXPathForElement(containerElement, document)
    }

    return undefined
  }

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const container = 'container' in app ? app.container : undefined
    if (container) {
      const xpath = getContainerXpath(container)
      if (xpath) {
        const parcelConfigGetterPromise = appConfigPormiseGetterMap.get(`${name}-${xpath}`)
        if (parcelConfigGetterPromise) {
          const parcelConfig = (await parcelConfigGetterPromise)(container)
          return {
            ...parcelConfig,
            // empty bootstrap hook which should not run twice while it calling from cached micro app
            bootstrap: () => Promise.resolve(),
          }
        }
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, configuration ?? frameworkConfiguration, lifeCycles)

    if (container) {
      const xpath = getContainerXpath(container)
      if (xpath) appConfigPormiseGetterMap.set(`${name}-${xpath}`, parcelConfigObjectGetterPromise)
    }

    return (await parcelConfigObjectGetterPromise)(container)
  }

  return mountRootParcel(memorizedLoadingFn, {domElement: document.createElement('div'), ...props})
}

/**
 * 正式运行 qiankun 微应用架构
 * @param opts
 */
export function start(opts: FrameworkConfiguration = {}) {
  frameworkConfiguration = {prefetch: true, singular: true, sandbox: true, ...opts}
  const {prefetch, sandbox, singular, urlRerouteOnly, ...importEntryOpts} = frameworkConfiguration

  /**
   * 执行预加载策略
   * 配置为 true 则会在第一个微应用 mount 完成后开始预加载其他微应用的静态资源
   * 配置为 'all' 则主应用 start 后即开始预加载所有微应用静态资源
   * 配置为 string[] 则会在第一个微应用 mounted 后开始加载数组内的微应用资源
   * 配置为 function 则可完全自定义应用的资源加载时机 (首屏应用及次屏应用)
   * 默认为 true
   */
  if (prefetch) {
    doPrefetchStrategy(microApps, prefetch, importEntryOpts)
  }

  /**
   * 沙箱配置检查
   */
  if (sandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox')
      frameworkConfiguration.sandbox = typeof sandbox === 'object' ? {...sandbox, loose: true} : {loose: true}
      if (!singular) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        )
      }
    }
  }

  startSingleSpa({urlRerouteOnly})

  frameworkStartedDefer.resolve()
}
