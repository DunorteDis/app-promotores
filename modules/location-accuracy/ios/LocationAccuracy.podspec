Pod::Spec.new do |s|
  s.name           = 'LocationAccuracy'
  s.version        = '1.0.0'
  s.summary        = 'Lê o accuracyAuthorization do CoreLocation (full/reduced).'
  s.description    = 'O expo-location expõe só o scope (whenInUse/always) no iOS. Este módulo entrega o equivalente ao androidAccuracy fine/coarse.'
  s.author         = 'Dunorte'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'MIT' }
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = "**/*.{h,m,swift}"
end
