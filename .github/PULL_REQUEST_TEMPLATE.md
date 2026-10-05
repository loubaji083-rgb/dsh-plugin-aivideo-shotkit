<!--
  感谢提交 PR。请把下面几栏填完，尤其是「怎么验证的」。
  这个项目的两条硬原则写在 CONTRIBUTING.md：零运行时依赖、不夸大能力。
-->

## 改了什么

<!-- 一到三句话。如果是修 bug，先说现象。 -->

## 为什么

<!--
  为什么必须这么改。如果试过别的写法但不行，把"为什么不行"也写下来——
  这个项目里最有价值的注释都是这种。
-->

## 怎么验证的

<!--
  请勾选你实际跑过的项，并贴出关键输出。
  改了 lib/tools.js 的话，host-load-test 是必须跑的。
-->

- [ ] `node --check` 全部通过
- [ ] `node scripts/host-load-test.mjs` 通过（51 项）
- [ ] `node scripts/make-demo-video.mjs --out demo/demo.mp4` 通过
- [ ] `node bin/shotkit.mjs run demo/demo.mp4 --out demo/out --filmstrip` 通过
- [ ] `node scripts/ci-assert-demo.mjs --out demo/out` 通过
- [ ] 在**真实素材**上手工验证过（说明素材特征，**不要上传视频**）

验证输出：

```
（贴在这里）
```

## 涉及判定 / 指标的改动

<!-- 没有就写"无"。有的话这一栏必须填。 -->

- 影响到的字段或判定：
- 验证素材的特征：
- 结论：
- **反例**（什么素材上这个判定会错）：

## 自查

- [ ] `package.json` 里没有新增 `dependencies`（核心只用 Node 内置模块）
- [ ] 新增的字符串面是中文，标识符/字段名是英文
- [ ] 新增的外部数字（某个工具支持多长、默认阈值等）写进了 `lib/core/tools-catalog.mjs` 并带出处 URL
- [ ] 文档（README / CHANGELOG / 技能文档）已同步
- [ ] 没有提交任何视频文件、个人路径或隐私信息 (`.gitignore` 已覆盖常见视频扩展名)

## 关联 issue

<!-- Closes #123 -->
