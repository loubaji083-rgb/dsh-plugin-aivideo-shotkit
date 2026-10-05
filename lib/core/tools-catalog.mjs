/**
 * The reference catalogue behind every recommendation: which tool fits which
 * motion regime, the parameters to feed it, and — most importantly — the
 * published *hard limits* that decide how short a clip has to be before it can
 * be handed to that tool at all.
 *
 * Kept in one file so the numbers in the workflow bundle, the CLI output and
 * the skill documentation cannot drift apart. Everything here is *starting*
 * advice transcribed from the published guidance of each project (the `source`
 * field points at where the number came from); it is not a claim that these
 * settings are optimal for a specific clip, and vendor limits do change.
 */

/**
 * Every mainstream character-replacement model is a *single-call, single-shot*
 * tool with a window measured either in seconds or in frames. The windows below
 * are the ones that were verifiable from primary sources; they are the reason
 * `aivideo_split` sub-divides long shots instead of emitting one long file.
 */
export const SEGMENT_PRESETS = {
  cloud: {
    id: 'cloud',
    label: '云端 API（Wan Animate / Kling / Viggle / Runway）',
    maxSegmentSec: 15,
    minSegmentSec: 3,
    overlapSec: 1,
    rationale:
      'Kling 3.0 系单次 3–15s、Viggle 驱动视频 5–15s、Wan Animate API 参考视频 2–30s、Runway Act-Two 3–30s。取 15s 作为上限是对所有四家的安全交集；3s 是最短限制（Runway）。',
  },
  opensource: {
    id: 'opensource',
    label: '本地开源（ComfyUI Wan Animate / VACE）',
    maxSegmentSec: 5,
    minSegmentSec: 2,
    overlapSec: 1,
    rationale:
      'ComfyUI WanAnimate2ToVideo 默认 length=81 帧 @16fps ≈ 5.06s，VACE/Wan2.1 同为 81 帧 @16fps，MimicMotion 72 帧 @576x1024，UniAnimate 32 帧。取 5s 正好是 81 帧的原生窗口（留出余量就落进 80 帧）；重叠 1.0s ≈ 16 帧（UniAnimate 的 context_overlap 默认 8、官方建议漂移时改 16）。',
  },
  tight: {
    id: 'tight',
    label: '极短窗口（身份漂移严重时的保守设置）',
    maxSegmentSec: 2,
    minSegmentSec: 1,
    overlapSec: 0.5,
    rationale:
      '按「1~1.5 秒小段 + 密集重叠」处理剧烈运动镜头。片段数最多、拼接最密，但每次调用拿到的动作量最小，时序一致性最好。注意 2s 已低于 Kling/Viggle/Runway 的最短限制（3s），只适合本地 VACE/ComfyUI 这类按帧数而非秒数限制的管线。',
  },
};

/** Stitching rules that the models themselves impose, quoted from the sources. */
export const STITCH_GUIDE = {
  stitchPoint: 'overlap-midpoint',
  stitchPointWhy:
    '重叠区间的两个端点恰好是两侧输出一致性最弱的时刻（Wan Animate 的 trim_image 语义、DreamActor-M1 用上一段 last latent 初始化下一段都指向同一结论），因此在重叠中点切换。',
  xfadeSeconds: 1.0,
  xfadeWhy: 'ffmpeg xfade 的 duration 默认 1.0（范围 0–60），两端都必须为恒定帧率且分辨率/像素格式/帧率/timebase 全一致。',
  mustNormaliseBeforeConcat: true,
  normaliseWhy:
    'concat 滤镜要求各段同名流数量一致、且"分辨率等设置必须由用户显式转换"；帧率不一致会输出 VFR。统一到 -pix_fmt yuv420p + 固定 -r 再拼。',
  concatAudioOption: 'a=1',
  concatAudioWhy: 'ffmpeg concat 滤镜的 a 选项默认为 0，即默认不处理音频，必须显式 a=1 才会把音轨带上。',
  keepAudio: true,
  keyframePinning: 'force_key_frames expr:gte(t,n_forced*<段长>)',
  keyframePinningWhy: '转中间格式时把关键帧钉在预期切点，后续才能用无损粗切对齐；否则 -c copy 只能切在最近关键帧上。',
};

export const TOOL_CATALOG = [
  {
    id: 'wan-animate',
    name: 'Wan Animate 2（阿里万相）',
    kind: '动作迁移 + 整身角色替换',
    fits: ['subtle', 'dynamic'],
    note: '给一段驱动视频 + 一张角色参考图，把原视频里的人物整体换成参考角色，保留动作与表情。开源权重 + 云 API + ComfyUI 官方节点三条路。',
    license: '开源权重（Wan2.2-Animate-14B）；API 走阿里云百炼',
    params: {
      resolution: '832x480（ComfyUI 节点默认宽高，步长 16）',
      length: '81 帧（步长 4）',
      fps: '16',
      pose_strength: '1.0（0–10）',
      pose_start_percent: '0.0',
      pose_end_percent: '1.0',
      reference_image_strength: '1.0（调高可抑制身份漂移）',
      video_frame_offset: '0（续接上一段时递增）',
      continue_motion: '上一段的动态序列（只取最后一帧作为起始运动帧）',
      trim_image: '跨段重叠的帧数',
    },
    limits: {
      referenceVideo: 'MP4/AVI/MOV；2–30 秒；宽高均 200–2048 px；宽高比 1:3–3:1；≤200 MB',
      referenceImage: 'JPG/PNG/BMP/WEBP；宽高均 200–4096 px；宽高比 1:3–3:1；≤5 MB',
      guidance: '角色在图与视频中的画面占比要相近，身体比例一致；模糊或低帧率素材会直接降质。',
    },
    source: 'https://www.alibabacloud.com/help/en/model-studio/wan-animate-move-api',
  },
  {
    id: 'vace',
    name: 'VACE（Wan 2.1 / 2.2 VACE）',
    kind: '可控视频重绘 / 全身替换',
    fits: ['subtle', 'dynamic', 'intense'],
    note: '把原视频当控制信号做全片重绘，适合需要换掉整个身体、服装甚至场景的镜头。官方能力表里有 Swap-Anything / Move-Anything / Reference-Anything。',
    license: 'Apache-2.0',
    params: {
      resolution: '1.3B≈480x832；14B≈720x1280',
      length: '81 帧',
      fps: '16',
      task: 'v2v / mv2v（--task depth | inpainting --mode bbox --bbox x1,y1,x2,y2）',
      strength: '0.7~0.9',
      preprocess: 'V2V/MV2V 必须先做 depth / pose / mask 前处理；R2V 可跳过',
    },
    limits: {
      resolution: '官方口径：支持任意分辨率，但落在推荐区间内效果才最好',
      length: '81 帧 @16fps ≈ 5.06 秒',
      crossCut: 'V2V/MV2V 逐帧对齐 depth/pose/mask，跨硬切处连续性断裂，必须逐镜头处理',
    },
    source: 'https://github.com/ali-vilab/VACE',
  },
  {
    id: 'kling',
    name: 'Kling 3.0 / O1（可灵）',
    kind: '元素替换 + 动作控制 + 数字人',
    fits: ['still', 'subtle', 'dynamic'],
    note: '云端商用首选；Multi-element Video Editing 支持标记/替换/增删画面元素。仅 3.0 系支持 multi-shot，其余版本单次调用即单镜头。',
    license: '商业 API',
    params: {
      duration: '3.0 系 3–15s；O1 / 2.6 为 3–10s；2.5 Turbo 仅 5s 或 10s',
      resolution: '720P / 1080P / 4K（按模型）',
      mode: 'Motion Control（3.0、2.6）/ Element Control（3.0、3.0 Omni、O1）/ Avatar + Lip Sync（全版本）',
    },
    limits: {
      multiShot: '仅 Kling 3.0 Turbo / 3.0 / 3.0 Omni 支持；O1、2.6、2.5 Turbo 明确 Not Supported',
      duration: '除 3.0 系外，单次调用即单镜头，硬切必须切开',
    },
    source: 'https://kling.ai/document-api/guides/capability-map/video.md',
  },
  {
    id: 'runway-act-two',
    name: 'Runway Act-Two',
    kind: '表演捕捉式整身/半身替换',
    fits: ['subtle', 'dynamic'],
    note: '官方最佳实践把"可替换"的前提写得很死：单一主体、面部全程可见、最远拍到腰部、镜头内不能有剪辑。',
    license: '商业 API（Act-One 已下线）',
    params: {
      duration: '3–30 秒',
      fps: '24',
      outputResolution: '16:9=1280x720；9:16=720x1280；1:1=960x960；4:3=1104x832；3:4=832x1104；21:9=1584x672',
      facialExpressiveness: '3（默认）',
    },
    limits: {
      hardRules: [
        'No cuts that interrupt the shot（镜头内不能有剪辑）',
        'Feature a single subject（单一主体）',
        "Ensure the subject's face remains visible throughout（面部全程可见）",
        'Frame the subject, at furthest, from the waist up（最远到腰）',
      ],
      duration: '3–30 秒',
    },
    source:
      'https://help.runwayml.com/hc/en-us/articles/42311337895827-Performance-Capture-with-Act-Two',
  },
  {
    id: 'viggle',
    name: 'Viggle AI',
    kind: '整身动作迁移 / 角色替换',
    fits: ['subtle', 'dynamic'],
    note: '按驱动视频秒数计费，没有调用方可控的 duration/quality/resolution/aspect_ratio。',
    license: '商业 API',
    params: { drivingVideo: '5–15 秒（先截断到整秒再校验）', cost: '1 credit/秒 ≈ $0.01' },
    limits: {
      drivingVideo: '5–15 秒，15.9 秒会被接受并按 16 秒计费',
      note: '该模式无 duration_s / quality / resolution / aspect_ratio 参数',
    },
    source: 'https://docs.viggle.ai/v1/pricing',
  },
  {
    id: 'liveportrait',
    name: 'LivePortrait',
    kind: '人脸表情驱动 / 换脸',
    fits: ['still', 'subtle'],
    note: '轻量、快、嘴型与表情迁移质量高；只在人脸清晰可见且占画面较大的镜头有效，不重建身体也不换服装。',
    license: 'MIT',
    params: {
      drivingCrop: '1:1（如 512x512 或 256x256），或使用 --flag_crop_driving_video',
      framing: 'Focus on the head area / Minimize shoulder movement',
      firstFrame: '必须是正面、中性表情',
    },
    limits: {
      framing: '只处理头部区域；肩部大幅运动与遮挡会明显降低可用性',
      firstFrame: '驱动视频首帧需正面 + 中性表情',
    },
    source: 'https://github.com/KwaiVGI/LivePortrait',
  },
  {
    id: 'latentsync',
    name: 'LatentSync / MuseTalk',
    kind: '口型同步换脸',
    fits: ['still', 'subtle'],
    note: '当角色需要开口说话时使用；与换脸模型串联。',
    license: '按具体实现（MuseTalk 为 MIT，LatentSync 见仓库）',
    params: { audio: '驱动音频 16k 单声道', faceRestore: 'GFPGAN 可选' },
    limits: { face: '需要稳定可见的嘴部区域，侧脸与遮挡会失效' },
    source: 'https://github.com/bytedance/LatentSync',
  },
  {
    id: 'kling-frames',
    name: 'Kling 首尾帧 / Runway Gen 图生视频',
    kind: '静帧再动画',
    fits: ['still'],
    note: '镜头基本静止时，最稳的做法是取一帧做角色替换后再生成运动，而不是直接替换视频中的人物。',
    license: '商业 API',
    params: { duration: '5s 或 10s', mode: '首帧驱动 / 首尾帧驱动' },
    limits: { duration: '5s 或 10s（按模型）' },
    source: 'https://kling.ai/document-api/guides/capability-map/video.md',
  },
  {
    id: 'comfyui',
    name: 'ComfyUI 工作流',
    kind: '本地编排',
    fits: ['still', 'subtle', 'dynamic', 'intense'],
    note: '把上述模型串成一条流水线：换脸 → 动作迁移 → 超分 → 合成。本插件导出的 workflow.json 可直接作为参数模板。',
    license: '取决于所加载的自定义节点',
    params: { sampler: 'uni_pc / dpmpp_2m', steps: '20~30', cfg: '5~7' },
    limits: { segment: '受底层模型的帧数上限约束，通常 81 帧 @16fps' },
    source: 'https://docs.comfy.org/built-in-nodes/WanAnimate2ToVideo',
  },
];

/**
 * Licence red lines worth surfacing before anyone ships a commercial cut.
 * Not legal advice — but the two most common swap stacks are non-commercial by
 * default, and that surprises people *after* they have built the pipeline.
 */
export const LICENSE_NOTES = [
  '人脸检测优先选 **YuNet**（OpenCV Zoo，整目录 MIT，可检 10x10–300x300 px 的人脸，WIDER Face AP 0.834/0.824/0.708）。',
  '**insightface / buffalo_l / inswapper_128.onnx / inswapper_128_fp16.onnx / codeformer-v0.1.0.pth 均为 non-commercial research only**；2025-11-24 起官方要求联系授权（recognition-oss-pack@insightface.ai）。ComfyUI-ReActor 的 credits 表也把这几项标为 non_commercial，仅 GFPGANv1.3/1.4 为 Apache-2.0。',
  '生成/替换环节的开源可商用候选：VACE / Wan2.1 系 **Apache-2.0**；LivePortrait、Champ、YuNet 为 **MIT**。',
  'OpenPose 的商用授权措辞未见一手文本（本次抓取超时），计划商用骨架提取前需自行核对 LICENSE。',
];

const PROMPT_BASE =
  '保持原始镜头运动、焦距与构图不变；只替换画面中的人物身份，其它元素（背景、光照、道具、粒子特效）完全保留。';

export const CATEGORIES = {
  still: {
    key: 'still',
    label: '静止镜头（可做静帧重绘）',
    reason: '画面几乎无运动，单帧信息即可代表整段',
    workflow: {
      summary:
        '镜头内运动量极低，最适合「取帧 → 换角色 → 重新生成运动」的两步法，成功率和可控性都最高。',
      tools: ['kling-frames', 'liveportrait', 'comfyui'],
      params: { maxClipSeconds: 10, keepLength: '可整段保留', retime: '无需' },
      prompt: `${PROMPT_BASE} 由于原镜头近乎静止，允许模型自行补充自然的呼吸、发丝与衣物摆动。`,
      notes: '若人脸清晰可见，直接走 LivePortrait 换脸即可，成本最低；若需换全身则走 VACE 静帧重绘。',
    },
  },
  subtle: {
    key: 'subtle',
    label: '轻微运动（换脸首选）',
    reason: '人物有小幅表演与位移，动作信息完整但不激烈',
    workflow: {
      summary:
        '这类镜头是人物替换的最佳输入：动作清晰、时序信息足够，主流模型都能稳定跟随。',
      tools: ['wan-animate', 'liveportrait', 'latentsync', 'comfyui'],
      params: { maxClipSeconds: 5, fps: '16~24', strength: '0.75~0.85', maskPadding: '面部区域外扩 15%' },
      prompt: `${PROMPT_BASE} 保留人物原有表情节奏与口型时机。`,
      notes: '超过 5 秒的镜头先按 4 秒左右切分，再逐段处理，最后用原音频对齐拼接。',
    },
  },
  dynamic: {
    key: 'dynamic',
    label: '中等运动（动作迁移）',
    reason: '人物有明确的大幅动作或镜头在移动',
    workflow: {
      summary: '动作幅度大，必须用带时序控制的模型做动作迁移，单纯的换脸会与身体脱节。',
      tools: ['wan-animate', 'vace', 'comfyui'],
      params: { maxClipSeconds: 5, fps: '16', strength: '0.8~0.9', shotSplit: '按 3~5 秒切段' },
      prompt: `${PROMPT_BASE} 严格跟随原视频的骨骼动作与镜头运动。`,
      notes: '建议先做光流稳定化再送模型；分段处理时保留约 0.5~1.0s 重叠以便对齐。',
    },
  },
  intense: {
    key: 'intense',
    label: '剧烈运动（需先切短）',
    reason: '运动量极高（快速摇镜、闪烁、拖影）',
    workflow: {
      summary:
        '画面运动过强，直接送入模型容易糊掉或丢失身份一致性；先切短再送（默认压到 3 秒，仍可再降到 1.5 秒），或改用长视频重绘（VACE）。',
      tools: ['vace', 'comfyui'],
      params: {
        maxClipSeconds: 3,
        segmentSeconds: '2~3（仍糊则降到 1.0~1.5）',
        overlap: '0.5s',
        preprocess: '光流稳定化 + 去拖影',
      },
      prompt: `${PROMPT_BASE} 优先保证身份一致性，允许适当降低动作幅度。`,
      notes: [
        '3 秒是「所有主流工具都还能吃下」的最短长度（Kling 3–15s、Wan Animate API 2–30s、Runway Act-Two 3–30s）；再短就只能本地按帧数限制的管线（VACE/ComfyUI）能用了。',
        '这类镜头失败率最高，建议放到最后处理，或用相邻的静止/轻微运动镜头替代叙事功能。',
        '若标记里有 global-motion（整幅运动），说明镜头本身在摇/甩，背景也在动，重构难度比同运动量的局部运动镜头高一档。',
      ],
    },
  },
};

export function toolById(id) {
  return TOOL_CATALOG.find((t) => t.id === id) || null;
}
