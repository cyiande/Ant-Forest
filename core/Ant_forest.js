/*
 * @Author: NickHopps
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2020-05-12 23:37:38
 * @Description: 蚂蚁森林操作集
 */
let { config: _config } = require('../config.js')(runtime, this)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, this)
let _widgetUtils = singletonRequire('WidgetUtils')
let automator = singletonRequire('Automator')
let _commonFunctions = singletonRequire('CommonFunction')
let _runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')
let alipayUnlocker = singletonRequire('AlipayUnlocker')
let callStateListener = singletonRequire('CallStateListener')
let FriendListScanner = require('./FriendListScanner.js')
let ImgBasedFriendListScanner = null
if (_config.base_on_image) {
  ImgBasedFriendListScanner = require('./ImgBasedFriendListScanner.js')
}
let BaseScanner = require('./BaseScanner.js')

function Ant_forest () {
  const _package_name = 'com.eg.android.AlipayGphone'
  let _base_scanner = new BaseScanner()

  let _pre_energy = 0, // 记录收取前能量值
    _post_energy = 0, // 记录收取后能量值
    _timestamp = 0, // 记录获取自身能量倒计时
    _min_countdown = null, // 最小可收取倒计时
    _current_time = 0, // 当前收集次数
    _fisrt_running = true, // 是否第一次进入蚂蚁森林
    _has_next = true, // 是否下一次运行
    _collect_any = false, // 收集过能量
    _re_try = 0,
    _lost_someone = false, // 是否漏收,
    _lost_reason = '', // 漏收原因
    _friends_min_countdown = null
  /***********************
   * 综合操作
   ***********************/

  // 进入蚂蚁森林主页
  const startApp = function () {
    _commonFunctions.launchPackage(_package_name, false)
    if (_config.is_alipay_locked) {
      alipayUnlocker.unlockAlipay()
    }
    app.startActivity({
      action: 'VIEW',
      data: 'alipays://platformapi/startapp?appId=60000002',
      packageName: _package_name
    })
  }

  const recordLost = function (reason) {
    _lost_someone = true
    _lost_reason = reason
  }

  /**
   * 关闭活动弹窗
   */
  const clearPopup = function () {
    // 合种/添加快捷方式提醒
    threads.start(function () {
      let floty = idEndsWith('J_pop_treedialog_close').findOne(
        _config.timeout_findOne
      )
      if (floty) {
        floty.click()
      }
    })
    threads.start(function () {

      let buttons = className('android.widget.Button')
        .desc('关闭').findOne(
          _config.timeout_findOne
        )
      if (buttons) {
        buttons.click()
      }
    })
    threads.start(function () {
      let floty = descEndsWith('关闭蒙层').findOne(_config.timeout_findOne)
      if (floty) {
        floty.click()
      }
      floty = textEndsWith('关闭蒙层').findOne(_config.timeout_findOne)
      if (floty) {
        floty.click()
      }
    })
    debugInfo('关闭蒙层成功')
  }

  // 显示文字悬浮窗
  const showFloaty = function (text) {
    _commonFunctions.closeFloatyWindow()
    let window = floaty.window(
      <card cardBackgroundColor="#aa000000" cardCornerRadius="20dp">
        <horizontal w="250" h="40" paddingLeft="15" gravity="center">
          <text
            id="log"
            w="180"
            h="30"
            textSize="12dp"
            textColor="#ffffff"
            layout_gravity="center"
            gravity="left|center"
          />
          <card
            id="stop"
            w="30"
            h="30"
            cardBackgroundColor="#fafafa"
            cardCornerRadius="15dp"
            layout_gravity="right|center"
            paddingRight="-15"
          >
            <text
              w="30"
              h="30"
              textSize="16dp"
              textColor="#000000"
              layout_gravity="center"
              gravity="center"
            >
              ×
            </text>
          </card>
        </horizontal>
      </card>
    )
    window.stop.on('click', () => {
      _runningQueueDispatcher.removeRunningTask()
      engines.myEngine().forceStop()
    })
    logInfo(text)
    ui.run(function () {
      window.log.text(text)
    })
  }

  /***********************
   * 构建下次运行
   ***********************/

  // 异步获取 toast 内容
  const getToastAsync = function (filter, limit, exec) {
    filter = typeof filter == null ? '' : filter
    let lock = threads.lock()
    let complete = lock.newCondition()
    let result = []
    lock.lock()

    // 在新线程中开启监听
    let thread = threads.start(function () {
      try {
        lock.lock()
        let temp = []
        let counter = 0
        let toastDone = false
        let startTimestamp = new Date().getTime()
        // 监控 toast
        events.onToast(function (toast) {
          if (toastDone) {
            return
          }
          if (
            toast &&
            toast.getPackageName() &&
            toast.getPackageName().indexOf(filter) >= 0
          ) {
            counter++
            temp.push(toast.getText())
            if (counter >= limit) {
              logInfo('正常获取toast信息' + temp)
              toastDone = true
            } else if (new Date().getTime() - startTimestamp > 10000) {
              warnInfo('等待超过十秒秒钟，直接返回结果')
              toastDone = true
            }
          } else {
            errorInfo('无法获取toast内容，直接返回[]')
            toastDone = true
          }
        })
        // 触发 toast
        limit = exec()
        let count = 3
        while (count-- > 0 && !toastDone) {
          sleep(1000)
        }
        if (!toastDone) {
          warnInfo('获取toast超时释放锁')
        }
        debugInfo('temp' + temp)
        result = temp
      } finally {
        complete.signal()
        lock.unlock()
      }
    })
    // 获取结果
    debugInfo('阻塞等待toast结果')
    complete.await()
    debugInfo('阻塞等待结束，等待锁释放')
    lock.unlock()
    debugInfo('获取toast结果成功：' + result)
    thread.interrupt()
    return result
  }

  // 获取自己的能量球中可收取倒计时的最小值
  const getMinCountdownOwn = function () {
    let target
    if (className('Button').descMatches(/\s/).exists()) {
      target = className('Button')
        .descMatches(/\s/)
        .filter(function (obj) {
          return obj.bounds().height() / obj.bounds().width() > 1.05
        })
    } else if (className('Button').textMatches(/\s/).exists()) {
      target = className('Button')
        .textMatches(/\s/)
        .filter(function (obj) {
          return obj.bounds().height() / obj.bounds().width() > 1.05
        })
    }
    let temp = []
    if (target && target.exists()) {
      let ball = target.untilFind()
      debugInfo('待收取球数' + ball.length)
      let toasts = getToastAsync(_package_name, ball.length >= 2 ? 2 : ball.length, function () {
        let screen = _commonFunctions.checkCaptureScreenPermission()
        let count = 0
        for (let i = 0; i < ball.length; i++) {
          let countDownBall = ball[i]
          let bounds = countDownBall.bounds()
          let halfHeight = parseInt(bounds.height() / 2)
          if (!images.findColor(screen, '#d1971a', {
            region: [bounds.left, bounds.top + parseInt(halfHeight / 2), bounds.right - bounds.left, halfHeight],
            threshold: _config.color_offset || 20
          })) {
            count++
          }
          automator.clickCenter(countDownBall)
          sleep(500)
          // 只需要点击两个球就够了
          if (count >= 2) {
            break
          }
        }
        // 返回实际倒计时个数
        return count
      })
      toasts.forEach(function (toast) {
        let countdown = toast.match(/\d+/g)
        if (countdown !== null && countdown.length >= 2) {
          temp.push(countdown[0] * 60 - -countdown[1])
        } else {
          errorInfo('获取倒计时错误：' + countdown)
        }
      })
      _min_countdown = Math.min.apply(null, temp)
    }
    _timestamp = new Date()
  }

  // 确定下一次收取倒计时
  const getMinCountdown = function () {
    let countDownNow = calculateMinCountdown()
    _min_countdown = isFinite(countDownNow) ? countDownNow : _min_countdown
    logInfo(['获取最终倒计时时间：{}', _min_countdown])
  }

  const calculateMinCountdown = function (lastMin, lastTimestamp) {
    let temp = []
    if (_friends_min_countdown && isFinite(_friends_min_countdown)) {
      temp.push(_friends_min_countdown)
    }
    if (_min_countdown && isFinite(_min_countdown) && _timestamp instanceof Date) {
      debugInfo('已记录自身倒计时：' + _min_countdown + '分')
      let passedTime = Math.round((new Date() - _timestamp) / 60000)
      let countdown_own = _min_countdown - passedTime
      debugInfo('本次收集经过了：[' + passedTime + ']分，最终记录自身倒计时：[' + countdown_own + ']分')
      countdown_own >= 0 ? temp.push(countdown_own) : temp.push(0)
    }
    if (isFinite(lastMin) && lastTimestamp instanceof Date) {
      debugInfo('上轮获取倒计时[' + lastMin + ']分')
      let passedTime = Math.round((new Date() - lastTimestamp) / 60000)
      lastMin = lastMin - passedTime
      debugInfo('重新获取倒计时经过了：[' + passedTime + ']分，最终记录上轮倒计时：[' + lastMin + ']分')
      lastMin >= 0 ? temp.push(lastMin) : temp.push(0)
    }
    // 基于图像处理且已开启OCR 倒计时已通过ocr获取，尝试一秒获取控件倒计时 否则按配置的时间获取
    // 后期基于图像分析有可能直接放弃控件获取
    let existTimeout = _config.base_on_image && _config.useOcr ? 1000 : null
    let friCountDownContainer = _widgetUtils.widgetGetAll('\\d+’', existTimeout, true)
    let peekCountdownContainer = function (container) {
      if (container) {
        return _commonFunctions.formatString('倒计时数据总长度：{} 文本属性来自[{}]', container.target.length, (container.isDesc ? 'desc' : 'text'))
      } else {
        return null
      }
    }
    debugInfo('get \\d+’ container:' + peekCountdownContainer(friCountDownContainer))
    if (friCountDownContainer) {
      let isDesc = friCountDownContainer.isDesc
      friCountDownContainer.target.forEach(function (countdown) {
        let countdown_fri = null
        if (isDesc) {
          countdown_fri = parseInt(countdown.desc().match(/\d+/))
        } else if (countdown.text()) {
          countdown_fri = parseInt(countdown.text().match(/\d+/))
        }
        if (countdown_fri) {
          temp.push(countdown_fri)
        }
      })
    }
    if (temp.length === 0) {
      return
    }
    temp = temp.filter(i => isFinite(i))
    let min = Math.min.apply(null, temp)
    min = isFinite(min) ? min : undefined
    debugInfo('获取倒计时最小值：[' + min + ']分')
    return min
  }


  // 构建下一次运行
  const generateNext = function () {
    // 循环模式，判断循环次数
    if (_config.is_cycle) {
      if (_current_time < _config.cycle_times) {
        _has_next = true
      } else {
        logInfo("达到最大循环次数")
        _has_next = false
      }
    } else {
      // 永不终止模式，判断倒计时不存在，直接等待配置的激活时间
      if (_config.never_stop) {
        if (_commonFunctions.isEmpty(_min_countdown) || _min_countdown > _config.reactive_time) {
          _min_countdown = _config.reactive_time || 60
        }
        _has_next = true
        return
      }
      // 计时模式 超过最大循环次数 退出执行
      if (_current_time >= _config.max_collect_repeat) {
        _has_next = false
        logInfo("达到最大循环次数")
        return
      }
      // 计时模式，超过最大等待时间 退出执行
      if (
        _min_countdown != null &&
        _min_countdown <= _config.max_collect_wait_time
      ) {
        _has_next = true
      } else {
        logInfo(_min_countdown + "超过最大等待时间")
        _has_next = false
      }
    }
  }

  /***********************
   * 记录能量
   ***********************/

  // 记录当前能量
  const getCurrentEnergy = function () {
    let currentEnergyWidget = _widgetUtils.widgetGetById(_config.energy_id || 'J_userEnergy')
    let currentEnergy = undefined
    if (currentEnergyWidget) {
      let content = currentEnergyWidget.text() || currentEnergyWidget.desc()
      currentEnergy = parseInt(content.match(/\d+/))
    }
    if (currentEnergy) {
      // 存储能量值数据
      _commonFunctions.storeEnergy(currentEnergy)
    }
    return currentEnergy
  }

  // 记录初始能量值
  const getPreEnergy = function () {
    let currentEnergy = getCurrentEnergy()
    if (_fisrt_running && _has_next) {
      _pre_energy = currentEnergy
      _commonFunctions.persistHistoryEnergy(currentEnergy)
      logInfo('当前能量：' + currentEnergy)
    }
    showCollectSummaryFloaty()
  }

  const showCollectSummaryFloaty = function (increased) {
    if (_config.is_cycle) {
      _commonFunctions.showCollectSummaryFloaty0(_post_energy - _pre_energy, _current_time, increased)
    } else {
      _commonFunctions.showCollectSummaryFloaty0(null, null, increased)
    }
  }

  // 记录最终能量值
  const getPostEnergy = function (collectedFriend) {
    if (collectedFriend) {
      debugInfo('非仅收自己，返回主页面')
      automator.back()
      _widgetUtils.homePageWaiting()
    }
    // 等待能量值稳定
    sleep(500)
    _post_energy = getCurrentEnergy()
    logInfo('当前能量：' + _post_energy)
    _commonFunctions.showEnergyInfo()
    let energyInfo = _commonFunctions.getTodaysRuntimeStorage('energy')
    if (!_has_next) {
      showFloaty('本次共收取：' + (_post_energy - _pre_energy) + 'g 能量，累积共收取' + energyInfo.totalIncrease + 'g')
    } else {
      showCollectSummaryFloaty()
    }
    // 循环模式、或者有漏收 不返回home
    if ((!_config.is_cycle || !_has_next) && !_lost_someone) {
      automator.clickClose()
      sleep(1000)
      // 返回最小化支付宝
      _commonFunctions.minimize()
    }
  }

  /***********************
   * 收取能量
   ***********************/

  /**
   * 收集目标能量球能量
   * 
   * @param {*} energy_ball 能量球对象
   * @param {boolean} isOwn 是否收集自身能量
   * @param {boolean} isDesc 是否是desc类型
   */
  const collectBallEnergy = function (energy_ball, isOwn, isDesc) {
    if (_config.skip_five && !isOwn) {
      let regexCheck = /(\d+)克/
      let execResult
      if (isDesc) {
        debugInfo('获取能量球desc数据')
        execResult = regexCheck.exec(energy_ball.desc())
      } else {
        debugInfo('获取能量球text数据')
        execResult = regexCheck.exec(energy_ball.text())
      }
      if (execResult.length > 1 && parseInt(execResult[1]) <= 5) {
        debugInfo(
          '能量小于等于五克跳过收取 ' + isDesc ? energy_ball.desc() : energy_ball.text()
        )
        return
      }
    }
    debugInfo(isDesc ? energy_ball.desc() : energy_ball.text())
    automator.clickCenter(energy_ball)
    if (!isOwn) {
      _collect_any = true
    }
    sleep(300)
  }

  // 收取能量
  const collectEnergy = function (own) {
    let isOwn = own || false
    let ballCheckContainer = _widgetUtils.widgetGetAll(_config.collectable_energy_ball_content, 1000, true)
    if (ballCheckContainer !== null) {
      debugInfo('能量球存在')
      ballCheckContainer.target
        .forEach(function (energy_ball) {
          collectBallEnergy(energy_ball, isOwn, ballCheckContainer.isDesc)
        })
    } else {
      debugInfo('无能量球可收取')
      if (_config.direct_use_img_collect_and_help) {
        debugInfo('尝试通过图像分析收取能量')
        _base_scanner.checkAndCollectByImg(true)
      } else if (_config.try_collect_by_multi_touch) {
        debugInfo('尝试通过直接点击区域收集能量')
        _base_scanner.multiTouchToCollect()
      }
    }
  }

  const findAndCollect = function () {
    let scanner = _config.base_on_image ? new ImgBasedFriendListScanner() : new FriendListScanner()
    scanner.init({ currentTime: _current_time, increaseEnergy: _post_energy - _pre_energy })
    let executeResult = scanner.start()
    // 执行失败 返回 true
    if (executeResult === true) {
      recordLost('收集执行失败')
    } else {
      _lost_someone = executeResult.lostSomeone
      _lost_reason = executeResult.lostReason
      _collect_any = executeResult.collectAny
      _friends_min_countdown = executeResult.minCountdown
    }
    scanner.destory()
    scanner = null
    return _lost_someone
  }


  /***********************
   * 主要函数
   ***********************/

  /**
   * 打开支付宝蚂蚁森林 并等待
   */
  const openAndWaitForPersonalHome = function () {
    let restartCount = 0
    let waitFlag
    let startWait = 1000
    if (!_config.is_cycle) {
      startApp()
      // 首次启动等待久一点
      sleep(1500)
    }
    while (!(waitFlag = _widgetUtils.homePageWaiting()) && restartCount++ < 5) {
      warnInfo('程序未启动，尝试再次唤醒')
      automator.clickClose()
      debugInfo('关闭H5')
      if (restartCount >= 3) {
        startWait += 200 * restartCount
        home()
      }
      sleep(1000)
      // 解锁并启动
      unlocker.exec()
      startApp(false)
      sleep(startWait)
    }
    if (!waitFlag && restartCount >= 5) {
      logInfo('退出脚本')
      engines.myEngine().forceStop()
    }
    logInfo('进入个人首页成功')
    clearPopup()
    getPreEnergy()
  }

  // 收取自己的能量
  const collectOwn = function () {
    _commonFunctions.addOpenPlacehold('开始收集自己能量')
    debugInfo('准备收集自己能量')
    collectEnergy(true)
    // 计时模式和只收自己时都去点击倒计时能量球 避免只收自己时控件刷新不及时导致漏收
    if (!_config.is_cycle || _config.collect_self_only) {
      debugInfo('准备计算最短时间')
      getMinCountdownOwn()
    }
    let energyAfterCollect = getCurrentEnergy()
    let collectedEnergy = energyAfterCollect - _pre_energy
    if (collectedEnergy) {
      logInfo(['收集自己能量：{}g', collectedEnergy])
      _base_scanner.showCollectSummaryFloaty(collectedEnergy)
    }
    _commonFunctions.addClosePlacehold("收集自己的能量完毕")
    _fisrt_running = false
  }

  // 收取好友的能量
  const collectFriend = function () {
    _commonFunctions.addOpenPlacehold('开始收集好友能量')
    automator.enterFriendList()
    let enterFlag = _widgetUtils.friendListWaiting()
    if (!enterFlag) {
      errorInfo('进入好友排行榜失败')
      recordLost('进入好友排行榜失败')
      return false
    }
    let loadedStatus = _widgetUtils.ensureRankListLoaded(3)
    if (!loadedStatus) {
      warnInfo('排行榜加载中')
      recordLost('排行榜加载中')
      return false
    }
    debugInfo('进入好友排行榜成功')
    if (true === findAndCollect()) {
      _min_countdown = null
      _has_next = true
      _current_time = _current_time == 0 ? 0 : _current_time - 1
      errorInfo('收集好友能量失败，重新开始')
      _re_try++
      return false
    } else {
      _re_try = 0
    }
    _commonFunctions.addClosePlacehold("收集好友能量结束")
  }

  const Executor = function () {
    this.eventSettingThread = null
    this.stopListenThread = null
    this.needRestart = false
    this.setupEventListeners = function () {
      this.eventSettingThread = threads.start(function () {
        events.setMaxListeners(0)
        events.observeToast()
      })
    }

    /**
     * 监听音量上键直接关闭 音量下延迟5分钟
     */
    this.listenStopCollect = function () {
      this.interruptStopListenThread()
      this.stopListenThread = threads.start(function () {
        infoLog('即将收取能量，运行中可按音量上键关闭', true)
        events.removeAllKeyDownListeners('volume_down')
        events.observeKey()
        events.on("key_down", function (keyCode, event) {
          let stop = false
          if (keyCode === 24) {
            stop = true
            warnInfo('关闭脚本', true)
            _commonFunctions.cancelAllTimedTasks()
          } else if (keyCode === 25) {
            if (_config.auto_set_brightness) {
              device.setBrightnessMode(1)
            }
            warnInfo('延迟五分钟后启动脚本', true)
            _commonFunctions.setUpAutoStart(5)
            stop = true
          }
          if (stop) {
            _runningQueueDispatcher.removeRunningTask()
            resourceMonitor.releaseAll()
            engines.myEngine().forceStop()
          }
        })
      })
    }

    this.readyForStart = function () {
      callStateListener.exitIfNotIdle()
      callStateListener.enableListener()
      _runningQueueDispatcher.addRunningTask()
      unlocker.exec()
      _commonFunctions.showDialogAndWait(true)
      this.listenStopCollect()
      _commonFunctions.showEnergyInfo()
    }

    this.endLoop = function () {
      callStateListener.disableListener()
      resourceMonitor.releaseAll()
      this.interruptStopListenThread()
      events.removeAllListeners('key_down')
      events.removeAllListeners('toast')
      _runningQueueDispatcher.removeRunningTask()
      if (_config.auto_lock === true && unlocker.needRelock() === true) {
        debugInfo('重新锁定屏幕')
        automator.lockScreen()
      }
      if (_config.auto_set_brightness) {
        device.setBrightnessMode(1)
      }
    }

    this.interruptStopListenThread = function () {
      if (this.stopListenThread !== null) {
        this.stopListenThread.interrupt()
        this.stopListenThread = null
      }
    }

    this.endCollect = function () {
      logInfo('收取结束')
      if (this.eventSettingThread != null) {
        this.eventSettingThread.interrupt()
        this.eventSettingThread = null
      }
    }
  }

  /**
   * 循环运行
   */
  const CycleExecutor = function () {
    Executor.call(this)

    this.execute = function () {
      this.setupEventListeners()
      this.readyForStart()
      _current_time = 0
      startApp()
      // 首次启动等待久一点
      sleep(1500)
      while (true) {
        _current_time++
        _commonFunctions.showEnergyInfo(_current_time)
        // 增加当天运行总次数
        _commonFunctions.increaseRunTimes()
        infoLog("========循环第" + _current_time + "次运行========")
        showCollectSummaryFloaty()
        try {
          openAndWaitForPersonalHome()
          if (!_config.not_collect_self) {
            collectOwn()
          }
          let runSuccess = true
          if (!_config.collect_self_only) {
            if (collectFriend() === false) {
              // 收集失败，重新开始
              _lost_someone = true
              _current_time = _current_time == 0 ? 0 : _current_time - 1
              _has_next = true
              runSuccess = false
            }
          }
          if (runSuccess) {
            generateNext()
            getPostEnergy(!_config.collect_self_only)
          }
        } catch (e) {
          errorInfo('发生异常 [' + e + ']')
          _current_time = _current_time == 0 ? 0 : _current_time - 1
          _commonFunctions.printExceptionStack(e)
          _has_next = true
          _re_try = 0
        }
        if (!_lost_someone && (_has_next === false || _re_try > 5)) {
          break
        }
        logInfo('========本轮结束========')
      }
      this.endLoop()
      this.endCollect()
      // 返回最小化支付宝
      _commonFunctions.minimize()
    }
  }

  /**
   * 计时运行
   */
  const CountdownExecutor = function () {
    Executor.call(this)

    this.doInLoop = function () {
      _min_countdown = null
      openAndWaitForPersonalHome()
      if (!_config.not_collect_self) {
        collectOwn()
      }
      let runSuccess = true
      let executeNext = false
      if (!_config.collect_self_only) {
        do {
          _collect_any = false
          if (collectFriend() === false) {
            // 收集失败，重新开始
            _lost_someone = true
            _current_time = _current_time == 0 ? 0 : _current_time - 1
            _has_next = true
            runSuccess = false
          }
          debugInfo(['收集好友能量结束，运行状态：{} 是否收集过: {} 是否重新校验排行榜：{}', runSuccess, _collect_any, _config.recheck_rank_list])
          executeNext = runSuccess && _collect_any && _config.recheck_rank_list
          if (executeNext) {
            automator.back()
          }
        } while (executeNext)
      }
      if (runSuccess) {
        if (!_config.is_cycle && !_lost_someone) {
          getMinCountdown()
        }
        generateNext()
        getPostEnergy(!_config.collect_self_only)
      }
    }

    this.execute = function () {
      this.setupEventListeners()
      _current_time = 0
      while (true) {
        _collect_any = false
        if (_lost_someone) {
          warnInfo('上一次收取有漏收，再次收集', true)
          warnInfo('漏收原因：' + _lost_reason)
          automator.back()
          _commonFunctions.getAndUpdateDismissReason('lost_someone')
          _lost_someone = false
          _lost_reason = ''
        } else {
          debugInfo(['获取到的倒计时时间：{}', _min_countdown])
          if (_min_countdown > 0) {
            // 提前10秒左右结束计时
            let delayTime = 10 / 60.0
            // 延迟自动启动，用于防止autoJs自动崩溃等情况下导致的问题
            delayTime += (_config.delayStartTime || 5000) / 60000.0
            _commonFunctions.setUpAutoStart(_min_countdown - delayTime)
            _runningQueueDispatcher.removeRunningTask()
            // 如果不驻留悬浮窗  则不延迟，直接关闭
            if (_config.not_lingering_float_window) {
              _runningQueueDispatcher.removeRunningTask()
              exit()
            } else {
              _commonFunctions.commonDelay(_min_countdown - delayTime)
            }
          }
        }
        this.readyForStart()
        let runTime = _commonFunctions.increaseRunTimes()
        infoLog("========第" + runTime + "次运行========")
        showCollectSummaryFloaty()
        debugInfo('展示悬浮窗完毕')
        _current_time++
        if (_config.develop_mode) {
          this.doInLoop()
        } else {
          try {
            this.doInLoop()
          } catch (e) {
            errorInfo('发生异常 [' + e + ']')
            recordLost('发生异常 [' + e + ']')
            _commonFunctions.printExceptionStack(e)
            _current_time = _current_time == 0 ? 0 : _current_time - 1
            _lost_someone = true
            _min_countdown = null
            _has_next = true
            _re_try = 0
          }
        }
        // 当前没有遗漏 准备结束当前循环
        if (!_lost_someone) {
          this.endLoop()
          if (_has_next === false || _re_try > 5) {
            break
          }
        }
        logInfo('========本轮结束========')
      }
      this.endCollect()
    }
  }

  return {
    exec: function () {
      let executor = null
      if (_config.is_cycle) {
        executor = new CycleExecutor()
      } else {
        executor = new CountdownExecutor()
      }
      executor.execute()
    }
  }
}

module.exports = new Ant_forest()
