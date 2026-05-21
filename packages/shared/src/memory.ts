const memoryRecallPattern =
  /(记得|想起|回忆|印象|了解我|认识我|我是谁|我的偏好|我的喜好|喜欢什么|偏好|memory|remember|recall|impression|know me|who am i)/i;
const memoryMutationPattern =
  /(请记住|帮我记住|替我记住|记住这|记下来|记下这|存到记忆|保存.*记忆|别忘了|我的名字是|我叫|以后叫我|可以叫我|叫我|我(?:很|最|也)?(?:喜欢|讨厌|不喜欢|偏好)|我的(?:偏好|喜好|爱好|生日|工作|职业|住址|城市|邮箱|电话)|please remember|remember that|keep in mind|don't forget|do not forget|my name is|call me|i (?:really |also )?(?:like|love|hate|dislike|prefer)|my (?:favorite|preference|birthday|job|work|city|email|phone))/i;

export function isMemoryRecallRequest(content: string) {
  return memoryRecallPattern.test(content);
}

export function isMemoryMutationRequest(content: string) {
  return memoryMutationPattern.test(content);
}
