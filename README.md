# vmware-console-mcp

用 MCP 工具操控 VMware Player / Workstation 虚拟机：**生命周期、文件传输、guest 进程/命令、画面截屏、键鼠模拟**。
底层只依赖 VMware 自己已开放的接口：

- **vmrun (VIX)** → 生命周期 / 快照 / 克隆 / 文件 / guest 执行 / 进程 / 截屏 / 键入
- **VMware 内置 VNC (RemoteDisplay.vnc.*) + RFB** → 控制台级截屏、鼠标、键盘（不需要在 guest 里装任何东西，BIOS/登录界面也能操作）

本地 VMware（Player/Workstation）部分零第三方依赖（只用 Node 内置模块）；ESXi / vCenter 部分使用 govc 单文件二进制（运行 scripts/fetch-govc.ps1 下载，或设置 GOVC_PATH）。

## 目录

~~~text
src/server.js        MCP stdio 服务器（JSON-RPC）
src/tools.js         本地 VMware 28 个工具（本地） + 29 个（ESXi） + 总注册表
src/tools-esxi.js    ESXi/vCenter 29 个工具（多主机）
src/esxi.js          govc 封装 + 主机注册表（config/esxi-hosts.json）
src/vmrun.js         vmrun 封装（自动探测 / 加密 VM / 超时保护）
src/vmx.js           .vmx 读写（VNC 配置，自动备份 .vmx.bak）
src/console.js       VNC 会话管理（截图缩放 / 鼠标 / 键盘）
src/rfb.js           RFB 客户端（VMware 握手怪癖、raw 编码、分块拼接）
src/des.js           VNC 认证用的纯 JS DES
src/png.js           PNG 编码
src/keysym.js        X11 keysym 映射（组合键、Unicode 输入）
tools/               govc 下载目录（二进制不入库，见 scripts/fetch-govc.*）
tools/vcsim/         vSphere 模拟器下载目录（仅测试用，不入库）
config/esxi-hosts.json  ESXi 主机注册表（运行 esxi_add_host 后生成）
tests/unit.test.js   单元测试（DES/PNG/keysym/ESXi HID/VNC URI）
tests/probe.js       MCP 协议冒烟测试
tests/e2e.js         本地 VM 端到端测试（VNC 截图/点击/打字/关机/删除）
tests/esxi-vcsim.js  ESXi 后端测试（对 vcsim 模拟器跑管理接口）
~~~

## 环境要求

- Windows（VMware Player/Workstation 已在默认路径安装；或设置 VMWARE_VMRUN 指向 vmrun.exe）
- Node.js >= 18
- 目标 VM 关机时才能改 VNC 配置（工具会检查）

## 接入 MCP

任意支持 stdio 的 MCP 客户端：

~~~json
{
  "mcpServers": {
    "vmware": {
      "command": "node",
      "args": ["<repo>/src/server.js"],
      "env": {
        "VMWARE_GUEST_USER": "<guest-user>",
        "VMWARE_GUEST_PASSWORD": "<guest-password>"
      }
    }
  }
}
~~~

Claude Code / Codex 也可以用命令行添加（把路径换成你的）：

~~~text
claude mcp add vmware -- node <repo>/src/server.js
codex mcp add vmware -- node <repo>/src/server.js
~~~

可选环境变量：

| 变量 | 用途 |
|---|---|
| VMWARE_VMRUN | vmrun.exe 绝对路径（默认自动探测 Workstation/Player） |
| VMRUN_HOST_TYPE | 强制 ws / player |
| VMWARE_VM_PASSWORD | 加密虚拟机（.vmx 加密）的密码，vmrun 会带 -vp |
| VMWARE_GUEST_USER / VMWARE_GUEST_PASSWORD | guest_* 工具的默认凭据 |
| VMWARE_MCP_DEBUG | 1 时把调试日志写到 stderr |
| GOVC_PATH | govc 可执行文件路径（默认 tools/govc.exe，先运行 scripts/fetch-govc.ps1；否则回退 PATH） |
| ESXI_HOSTS_FILE | ESXi 主机注册表路径（默认 config/esxi-hosts.json） |
| ESXI_GUEST_USER / ESXI_GUEST_PASSWORD | esxi_guest_* 工具的默认 guest 凭据 |

## 快速开始（控制台自动化，不装 guest 端）

1. 关机目标 VM。
2. 调用 vnc_enable {vmx: "D:\VMs\my-vm\my-vm.vmx", port: 5901, password: "<8-char-pw>"}  
   → 自动备份 .vmx、写入 RemoteDisplay.vnc.enabled/port/password/ip=127.0.0.1。
3. 调用 vm_power {vmx, action: "start", gui: false}  
   → 无头启动并等待 VNC 端口就绪。**不要用 Player GUI 启动**：Player GUI 启动时会传 RemoteDisplay.vnc.enabled=FALSE，把配置覆盖掉。
4. 调用 console_screenshot {vmx} → 返回 PNG（BIOS / 登录界面 / 桌面都能抓）。
5. console_mouse / console_type / console_key 操作画面。
6. vm_power {action: "stop", mode: "hard"} 关机。

已验证的效果（VMware Player 17.5 实测）：

- demo/bios-setup.png：PhoenixBIOS Setup 界面（开机前截图，来自一次性临时 VM）
- 真实主机/客户机截图属于内部资料，放在 demo/private/（git-ignored），不随仓库发布
- tests/e2e.js 全流程通过：vnc_enable → start → screenshot → mouse move/click → type → ctrl+alt+delete → screenshot → stop

## ESXi / vCenter 多主机（govc 后端）

支持同时管理多个 ESXi 主机（也兼容 vCenter）；每台主机一个 alias，只读查询省略 alias 时会并行查全部主机。
后端使用 govmomi 官方 CLI govc（运行 scripts/fetch-govc.ps1 下载 v0.56.2，二进制不入库），无需在 ESXi 上装任何 agent。

### 添加主机

~~~json
{ "alias": "lab1", "host": "192.0.2.10", "user": "root", "password": "***" }
~~~
或推荐用环境变量保存密码：
~~~json
{ "alias": "lab1", "host": "192.0.2.10", "user": "root", "password_env": "ESXI_LAB1_PASS" }
~~~
调用 esxi_add_host（默认会先跑 govc about 验证，失败不落盘）。配置在 config/esxi-hosts.json；
esxi_hosts 查看全部主机，esxi_remove_host 删除。

### 管理工具（29 个）

| 分组 | 工具 |
|---|---|
| 主机 | esxi_hosts, esxi_add_host, esxi_remove_host, esxi_test_host, esxi_host_info, esxi_firewall |
| 虚拟机 | esxi_vm_list, esxi_vm_info, esxi_vm_power(start/stop/reset/reboot/suspend), esxi_vm_create, esxi_vm_clone, esxi_vm_destroy, esxi_vm_register |
| 快照 | esxi_snapshot(list/create/revert/remove) |
| 存储 | esxi_datastore_ls, esxi_datastore_upload, esxi_datastore_download |
| guest 内（Tools） | esxi_guest_run, esxi_guest_ps, esxi_guest_kill, esxi_guest_ls, esxi_guest_mkdir, esxi_guest_upload, esxi_guest_download |
| 控制台 | esxi_console_screenshot, esxi_console_key, esxi_console_type, esxi_console_mouse, esxi_vnc |

### ESXi 控制台能力（与本地 VMware 的差异）

| 能力 | 实现方式 | 是否需要 Tools / 防火墙 |
|---|---|---|
| 截屏 | esxi_console_screenshot -> govc vm.console -capture（ESXi 的 /screen HTTP 端点） | 不需要 Tools；不经过 VNC 防火墙，开箱即用 |
| 键盘 | esxi_console_key / esxi_console_type -> govc vm.keystrokes（vSphere PutUsbScanCodes） | 不需要 Tools，BIOS/安装程序也能输入；不需要防火墙 |
| 鼠标 | esxi_console_mouse -> VM 内置 VNC（RFB），可经 SSH 隧道 | ESXi 没有公开鼠标 API；需要 esxi_vnc enable + 电源重开；外网访问要过防火墙，推荐 SSH 隧道（见下） |
| VNC | esxi_vnc(status/enable/disable) -> govc vm.vnc 改 extraConfig | 关机时 enable，开机生效；端口/密码自动分配 |
| 防火墙 | esxi_firewall(list/enable) -> govc host.esxcli | 只能启用已存在的规则集；ESXi 默认没有 vnc 规则集，需 SSH 手建 /etc/vmware/firewall/vnc.xml 后 esxcli network firewall refresh |

结论：看画面 + 按键盘完全不需要 guest 端和防火墙（截屏 + PutUsbScanCodes）；需要鼠标时才走 VNC。

### 鼠标：SSH 隧道方式（推荐，不改 ESXi 防火墙）

ESXi 默认没有 vnc 防火墙规则集。用 SSH 本地转发绕过（ESXi 22 端口已开）：

~~~text
ssh -L 15902:127.0.0.1:5902 root@<esxi-host>
esxi_vnc {alias:"lab1", vm:"win10", action:"enable", port:5902, password:"********"}
esxi_vm_power {alias:"lab1", vm:"test-vm", action:"start"}
esxi_console_mouse {alias:"lab1", vm:"test-vm", action:"click", x:960, y:552,
                    vnc_host:"127.0.0.1", vnc_port:15902}
~~~

### 实测记录（2026-11-12，两台 ESXi 6.5 测试主机）

| 能力 | 结果 |
|---|---|
| esxi_add_host / test_host / host_info | 通（CPU/内存/版本信息正常；API 6.5） |
| esxi_vm_list | 两台主机共约 100 台 VM，含电源状态/IP/guest 类型 |
| esxi_vm_power start/stop | 通（test-vm 开关机验证） |
| esxi_console_screenshot | 通，无需 Tools；1920x1104 PNG（开机 "Please wait"、锁屏、桌面都抓到） |
| esxi_console_key / type | 通（PutUsbScanCodes）：Enter 推进画面、文本输入 + 退格清除 |
| esxi_vnc status/enable/disable | 通，返回 vnc://:pass@host:port |
| VNC 截屏 + 鼠标 + 按键（SSH 隧道） | 通：RFB 3.8，1920x1104 全帧；鼠标点击后光标出现在屏幕中央（截图对比） |
| esxi_snapshot list | 通 |
| esxi_datastore mkdir/upload/ls/download/rm | 通（<datastore>：上传→列目录→下载→内容一致→删除） |
| esxi_firewall list | 通（46 个规则集，无 vnc 规则集，故鼠标走隧道） |
| esxi_guest_* | ✅（Windows 本地账号）：进程表、run（echo/whoami）、mkdir/upload/ls/download 往返、启动进程后按 PID kill 并验证消失 |

> 注意：ESXi 6.5 的 VNC 在实测中协商出 security=none（即使设置了 RemoteDisplay.vnc.password），因此**不要把 VNC 端口直接暴露到网络**；用 SSH 隧道或只绑内网/防火墙白名单。



### 多主机示例

~~~text
esxi_vm_list                         # 所有已登记主机的 VM（并行）
esxi_vm_power  {alias:"lab1", vm:"win10", action:"start"}
esxi_snapshot  {alias:"lab1", vm:"win10", action:"create", name:"before-test"}
esxi_console_key {alias:"lab1", vm:"win10", keys:"f2"}      # 进 BIOS
esxi_console_type {alias:"lab1", vm:"win10", text:"hello", enter:true}
~~~

## 工具清单

### 生命周期 / 配置（vmrun）

| 工具 | 说明 |
|---|---|
| vm_list | 运行中的 VM 列表（含 VNC 配置） |
| vm_info | 单台 VM：显示名、guestOS、运行状态、Tools 状态、VNC 配置 |
| vm_power | start / stop / reset / suspend / pause / unpause（start 默认 gui=false） |
| vm_snapshot | list / create / revert / delete |
| vm_clone | full / linked 克隆 |
| vm_delete | 删除 VM（运行中需 force=true） |
| vm_tools_state | VMware Tools 状态 |
| vm_ip | guest IP（需要 Tools） |
| vm_install_tools | 挂载 Tools ISO 并安装 |
| vnc_enable / vnc_disable / vnc_status | 内置 VNC 开关、端口、密码、监听状态 |

### 控制台（VNC，无需 guest 端）

| 工具 | 说明 |
|---|---|
| console_info | 连接并返回分辨率、名称、认证方式 |
| console_screenshot | 截屏返回 PNG（可选 max_width 缩放、save_path 落盘） |
| console_mouse | move / click / dblclick / rightclick / down / up / scroll |
| console_type | 输入文本（物理按键，BIOS 也可用） |
| console_key | 组合键，如 ctrl+alt+delete、f2 |
| console_close | 关闭 VNC 会话（不关机） |

### guest 操作（需要 VMware Tools + 登录凭据）

| 工具 | 说明 |
|---|---|
| guest_run | 运行程序并返回退出码/输出 |
| guest_script | 运行脚本（解释器 + 脚本文本） |
| guest_processes / guest_kill | 进程枚举 / 终止 |
| guest_copy_to / guest_copy_from | 文件双向传输 |
| guest_mkdir / guest_ls | 目录操作 |
| guest_type_keystrokes | 向 guest 键入（Tools 通道，适合已登录桌面） |
| guest_screenshot | VIX captureScreen（Tools 通道；控制台截图请用 console_screenshot） |

## 关键限制与坑

1. **VNC 配置只在开机时读取**：必须关机 → vnc_enable → 用 vm_power 以 gui=false 启动。Player GUI 启动会强制 VNC=FALSE（实测）。
2. **加密 VM**：vmrun 会要求密码；设置 VMWARE_VM_PASSWORD（自动加 -vp），例如 D:\VMs\my-vm\my-vm.vmx 这类加密虚拟机。
3. **VMware Player 的功能集**：快照 / 克隆 / 模板属于 Workstation Pro 功能；Player 下 vmrun 可能返回"此操作不受支持"（实测 listSnapshots）。需要这些能力请安装 Workstation Pro。
4. **guest_* 需要 Tools 且已登录**：无 Tools 时 vmrun 不会立刻报错而是挂起，本工具会先用 checkToolsState 预检并给出明确错误；如果仍有挂起，请传 timeout_ms。
5. **坐标与缩放**：console_screenshot 默认原始分辨率；若传了 max_width，返回的 scale 要原样传给 console_mouse（x/y 按 scale 换算）。
6. **VNC 安全**：password 最长 8 字符且传输不加密；工具只允许 bind 到 127.0.0.1/localhost/::1。不要暴露到局域网。
7. **GUI 与自动化互斥**：用 vmrun 无头启动后，Player 窗口不会显示该 VM（任务栏看不到），要人工看画面需用 VNC 客户端连 127.0.0.1:5901。同一 VM 不要同时用 GUI 启动。
8. **ESXi 需要 govc**：先运行 scripts/fetch-govc.ps1（Linux/macOS 用 scripts/fetch-govc.sh）；缺失时所有 esxi_* 工具会报 govc 路径错误，也可设 GOVC_PATH。
9. **ESXi 鼠标只有 VNC 通道**：vSphere API 没有鼠标注入方法，esxi_console_mouse 依赖 esxi_vnc + 防火墙；纯键盘操作请用 esxi_console_key（无需 Tools/防火墙）。
10. **ESXi 截屏依赖 /screen 端点**：独立 ESXi 可用；vCenter 或某些版本失败时会自动回退到 VNC 截屏。
11. **esxi_* 凭据**：esxi_add_host 直接传 password 会明文写入 config/esxi-hosts.json（权限尽力收紧）；推荐 password_env。

## 测试

~~~text
node --test tests/unit.test.js     # DES/PNG/keysym 单元测试
node tests/probe.js               # MCP 协议 + 工具清单
node tests/e2e.js --password test1234   # 本地 VM 端到端（会创建/删除一台临时空 VM，约 40 秒）
node tests/esxi-vcsim.js          # ESXi 后端测试（启动 vcsim 模拟器，验证 govc 管理接口）
node tests/esxi-live.js <alias> --vm <name> --screenshot   # 对真实主机做只读/截屏验证（需先 esxi_add_host）
# 已验证：add_host / hosts / vm_list / vm_info / vm_power / snapshot(create,list,revert,remove) / datastore_ls / host_info / vnc(status,enable) / remove_host
~~~

e2e 会临时创建一台 256MB 空 VM（tmp/e2e-vm），结束后通过 vm_delete 与文件清理删除，不碰现有虚拟机。

## 安全建议

- 这套工具等于把虚拟机控制台交给 agent；只在可丢弃的 VM / 快照上做自动化。
- 默认 loopback + 密码；生产环境建议再套 MCP 客户端侧的审批策略。
- agent 的截图会带着客户机画面进入模型上下文，注意凭据与敏感信息。

完整的安全注意事项见 [SECURITY.md](SECURITY.md)；贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证与第三方

- 本项目代码：MIT，见 [LICENSE](LICENSE)。
- govc / govmomi：Apache-2.0，运行 scripts/fetch-govc.* 时从官方 release 下载，**不随仓库分发**；src/tools-esxi.js 的 USB HID 键码表改编自 govc 源码，详见 [NOTICE](NOTICE)。
- X11 keysyms、VMware 商标声明与"非官方项目"声明同样见 [NOTICE](NOTICE)。

> 本项目是独立的非官方自动化工具，与 Broadcom/VMware 无隶属关系；不重新分发 VMware 的任何二进制文件。