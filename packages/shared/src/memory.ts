const memoryRecallPattern =
  /(记得|想起|回忆|印象|了解我|认识我|我是谁|我的偏好|我的喜好|喜欢什么|偏好|memory|remember|recall|impression|know me|who am i)/i;

export function isMemoryRecallRequest(content: string) {
  return memoryRecallPattern.test(content);
}
